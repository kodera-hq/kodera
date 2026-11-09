import test from 'node:test';
import assert from 'node:assert/strict';
import {createExtensionTestHarness, signWebhookPayload} from '@kodera/extension-sdk';
import {manifest, EVENTS, validateAssetUrl, cleanText, buildReviewCard, createFrameioWebhookHandler, frameioReviewCommand} from '../index.mjs';
const secret='frameio-test-signing-secret-0123456789';
test('manifest and command declare minimal permissions',()=>{assert.equal(manifest.id,'frameio-review-bridge');assert.equal(frameioReviewCommand.name,'frameio-review');});
for(const url of ['http://app.frame.io/x','https://127.0.0.1/x','https://app.frame.io.evil.org/x','https://user:pass@app.frame.io/x','https://app.frame.io:444/x','https://app.frame.io/x#fragment','https://app.frame.io/\\evil'])test('refuses unsafe URL '+url,()=>assert.throws(()=>validateAssetUrl(url)));
test('bounds and sanitizes comments without uncontrolled mentions',()=>{assert.equal(cleanText('<b>@everyone</b> [bad](javascript:alert(1))'),'everyone badjavascript:alert1');assert.throws(()=>cleanText('x'.repeat(4097)));});
for(const event of EVENTS)test('routes '+event+' without trusting a supplied channel',()=>{const card=buildReviewCard(event,{id:'asset-1',url:'https://app.frame.io/reviews/a',title:'Ready',comment:'Good',timecode:'01:14:08:12',status:'Approved',channelId:'other'});assert.equal(card.channelId,event==='asset.ready'?'dailies-rushes':'post-production');assert.match(card.text,/@post-production/);});
test('refuses invalid frames and status',()=>{for(const timecode of ['01:60:00:00','01:14:08:99','bad'])assert.throws(()=>buildReviewCard('comment.created',{id:'a',url:'https://app.frame.io/a',timecode,comment:'x'}));assert.throws(()=>buildReviewCard('review.status_changed',{id:'a',url:'https://app.frame.io/a',status:'arbitrary'}));});
test('signed delivery posts once and refuses replay and tampering',async()=>{
 const handler=createFrameioWebhookHandler({secret});const harness=createExtensionTestHarness({secret,handler,nowSeconds:1762520000});
 const args={event:'asset.ready',deliveryId:'frameio-delivery-1',payload:{id:'asset-1',url:'https://app.frame.io/reviews/a',title:'Ready'}};
 const result=await harness.sendWebhook(args);assert.equal(result.response.result.posted,true);assert.equal(harness.recordedCalls[0].body.channelId,'dailies-rushes');await assert.rejects(()=>harness.sendWebhook(args));
 const rawBody=JSON.stringify({event:'asset.ready',id:'changed'});await assert.rejects(()=>handler({rawBody,headers:{'x-kodera-signature-256':signWebhookPayload(secret,1762520000,'{}'),'x-kodera-timestamp':'1762520000'},nowUnixSeconds:1762520000}));
});
