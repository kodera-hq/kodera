"""The provisioning worker: a separate process with no inbound network (ADR-0003, ADR-0004).

`python -m worker run` starts it. Nothing here runs on import: the boundary is entered by
`worker.boot.enter()`, which the entrypoint calls before Django or any application code loads.
"""
