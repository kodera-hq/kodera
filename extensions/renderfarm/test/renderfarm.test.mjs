import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  WebhookVerificationError,
} from '@kodera/extension-sdk';
import {
  createRenderfarmWebhookHandler,
  extensionManifest,
  formatAverageFrameTime,
  handleRenderCommand,
  parseFrameRange,
  sanitizeRenderOutputUri,
  signRenderfarmWebhookPayload,
  validateWorkerHostname,
} from '../index.mjs';

const TEST_SECRET = 'whsec_renderfarm_flamenco_deadline_0123456789';
const FIXED_NOW = 1_762_610_000;

test('renderfarm manifest validates cleanly and registers /render', () => {
  assert.equal(extensionManifest.canonicalId, 'io.kodera.ext.renderfarm');
  assert.equal(extensionManifest.slug, 'renderfarm');
  assert.equal(extensionManifest.commands[0].name, 'render');
});

test('parseFrameRange, formatAverageFrameTime, validateWorkerHostname, and sanitizeRenderOutputUri enforce strict studio bounds', () => {
  const range = parseFrameRange('1001-1120');
  assert.equal(range.normalized, '1001-1120');
  assert.equal(range.startFrame, 1001);
  assert.equal(range.endFrame, 1120);
  assert.equal(range.totalFrames, 120);

  const stepped = parseFrameRange('1001-1011x2,1020');
  assert.equal(stepped.totalFrames, 7);

  assert.throws(
    () => parseFrameRange('1120-1001'),
    (err) => err instanceof ExtensionSdkError && err.code === 'INVALID_FRAME_RANGE'
  );

  assert.equal(formatAverageFrameTime(42.34).formatted, '42.3s/frame');
  assert.equal(formatAverageFrameTime(134.5).formatted, '2m 14.5s/frame');
  assert.equal(formatAverageFrameTime(3852).formatted, '1h 04m 12s/frame');

  assert.equal(validateWorkerHostname('Blade-GPU-07.Farm.Studio.Example.'), 'blade-gpu-07.farm.studio.example');
  assert.throws(
    () => validateWorkerHostname('bad host;rm -rf /'),
    (err) => err instanceof ExtensionSdkError && err.code === 'INVALID_WORKER_HOSTNAME'
  );

  assert.equal(
    sanitizeRenderOutputUri('/mnt/renders/SEQ010/SH040/v003'),
    '/mnt/renders/SEQ010/SH040/v003'
  );
  assert.equal(
    sanitizeRenderOutputUri('s3://studio-renders-eu/SEQ010/SH040/exr'),
    's3://studio-renders-eu/SEQ010/SH040/exr'
  );
  assert.equal(
    sanitizeRenderOutputUri('https://storage.studio.example/renders/SH040?token=secret_presigned'),
    'https://storage.studio.example/renders/SH040'
  );

  for (const badUri of [
    '/Users/artist/Desktop/renders',
    '/mnt/renders/../../etc/passwd',
    'http://storage.studio.example/renders/SH040',
    'https://127.0.0.1/renders',
    'file:///etc/passwd',
  ]) {
    assert.throws(
      () => sanitizeRenderOutputUri(badUri),
      (err) => err instanceof ExtensionSdkError,
      `Expected ${badUri} to be rejected`
    );
  }
});

test('Flamenco job lifecycle threads job.completed onto job.started and routes task.oom_killed + Deadline failures to incidents', async () => {
  const messages = [];
  const replies = [];
  const incidents = [];

  const client = {
    async postChannelMessage(msg) {
      messages.push(msg);
      return { id: `msg_job_${messages.length}` };
    },
    async postThreadReply(reply) {
      replies.push(reply);
      return { id: `reply_job_${replies.length}` };
    },
    async postIncidentCard(inc) {
      incidents.push(inc);
      return { id: `inc_job_${incidents.length}` };
    },
  };

  const handler = createRenderfarmWebhookHandler({
    secret: TEST_SECRET,
    defaultChannelId: 'chan_wrangling',
    dashboardOrigin: 'https://flamenco.studio.example',
    client,
  });

  // 1. Flamenco job.started
  const startedBody = JSON.stringify({
    event: 'job.started',
    scheduler: 'flamenco',
    job: {
      id: 'flm_job_42',
      name: 'SEQ020_SH080_lighting_v05',
      type: 'blender-cycles',
      settings: {
        shot_code: 'SEQ020_SH080',
        frames: '1001-1120',
        render_output_root: '/renders/SEQ020/SH080/v005',
      },
    },
    avgFrameSeconds: 95.4,
    worker: { hostname: 'gpu-node-12.farm.example' },
  });
  const sigStart = signRenderfarmWebhookPayload(TEST_SECRET, FIXED_NOW, startedBody);
  const startRes = await handler({
    rawBody: startedBody,
    headers: {
      'x-renderfarm-timestamp': String(FIXED_NOW),
      'x-renderfarm-signature': sigStart,
      'x-renderfarm-delivery': 'rf_1',
    },
    nowUnixSeconds: FIXED_NOW,
  });
  assert.equal(startRes.status, 200);
  assert.equal(messages.length, 1);
  assert.ok(messages[0].text.includes('SEQ020_SH080'));
  assert.ok(messages[0].text.includes('1001-1120'));
  assert.ok(messages[0].text.includes('1m 35.4s/frame'));

  // 2. Flamenco job.completed threads onto job.started
  const completedBody = JSON.stringify({
    event: 'job.completed',
    scheduler: 'flamenco',
    job: {
      id: 'flm_job_42',
      name: 'SEQ020_SH080_lighting_v05',
      settings: {
        shot_code: 'SEQ020_SH080',
        frames: '1001-1120',
        render_output_root: '/renders/SEQ020/SH080/v005',
      },
    },
    avgFrameSeconds: 88.2,
    worker: { hostname: 'gpu-node-12.farm.example' },
  });
  const sigDone = signRenderfarmWebhookPayload(TEST_SECRET, FIXED_NOW + 5, completedBody);
  const doneRes = await handler({
    rawBody: completedBody,
    headers: {
      'x-renderfarm-timestamp': String(FIXED_NOW + 5),
      'x-renderfarm-signature': sigDone,
      'x-renderfarm-delivery': 'rf_2',
    },
    nowUnixSeconds: FIXED_NOW + 5,
  });
  assert.equal(doneRes.result.threaded, true);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].threadRootId, 'msg_job_1');

  // 3. Flamenco task.oom_killed posts critical incident
  const oomBody = JSON.stringify({
    event: 'task.oom_killed',
    scheduler: 'flamenco',
    job: {
      id: 'flm_job_99',
      name: 'SEQ030_SH010_fx_water',
      settings: {
        shot_code: 'SEQ030_SH010',
        frames: '1001-1080',
        render_output_root: '/mnt/renders/SEQ030/SH010/fx',
      },
    },
    task: {
      frame: 1044,
      duration_seconds: 212.0,
      peak_memory_gib: 23.9,
      error: '<b>CUDA out of memory</b> allocating displacement BVH',
    },
    worker: { hostname: 'gpu-node-03.farm.example' },
  });
  const sigOom = signRenderfarmWebhookPayload(TEST_SECRET, FIXED_NOW + 10, oomBody);
  await handler({
    rawBody: oomBody,
    headers: {
      'x-renderfarm-timestamp': String(FIXED_NOW + 10),
      'x-renderfarm-signature': sigOom,
      'x-renderfarm-delivery': 'rf_3',
    },
    nowUnixSeconds: FIXED_NOW + 10,
  });
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].severity, 'critical');
  assert.ok(incidents[0].title.includes('frame 1044'));
  assert.ok(incidents[0].summary.includes('23.9 GiB'));
  assert.ok(!incidents[0].summary.includes('<b>'));

  // 4. Deadline OnJobFailed payload normalizes and posts high-severity incident
  const deadlineFailBody = JSON.stringify({
    EventType: 'OnJobFailed',
    JobId: 'dl_6601a',
    JobName: 'SEQ040_SH020_arnold_v02',
    ExtraInfo0: 'SEQ040_SH020',
    Plugin: 'MayaArnold',
    FramesList: '1001-1050',
    AverageFrameTimeSeconds: 310,
    SlaveName: 'deadline-blade-09',
    OutputDirectories: ['/volumes/showA/SEQ040/SH020'],
    ErrorMessage: 'Missing texture UDIM 1004',
  });
  const sigDl = signRenderfarmWebhookPayload(TEST_SECRET, FIXED_NOW + 15, deadlineFailBody);
  const dlRes = await handler({
    rawBody: deadlineFailBody,
    headers: {
      'x-renderfarm-timestamp': String(FIXED_NOW + 15),
      'x-renderfarm-signature': sigDl,
      'x-renderfarm-delivery': 'rf_4',
    },
    nowUnixSeconds: FIXED_NOW + 15,
  });
  assert.equal(dlRes.result.scheduler, 'deadline');
  assert.equal(incidents.length, 2);
  assert.equal(incidents[1].severity, 'high');

  // Duplicate delivery rejected
  await assert.rejects(
    () =>
      handler({
        rawBody: deadlineFailBody,
        headers: {
          'x-renderfarm-timestamp': String(FIXED_NOW + 15),
          'x-renderfarm-signature': sigDl,
          'x-renderfarm-delivery': 'rf_5',
        },
        nowUnixSeconds: FIXED_NOW + 16,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_DETECTED'
  );

  // Slash command check
  const shotCmd = handleRenderCommand({
    rawCommand: '/render shot SEQ020_SH080 --frames=1001-1120',
  });
  assert.equal(shotCmd.frameRange.totalFrames, 120);
});
