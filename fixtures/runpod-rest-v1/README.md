# RunPod REST v1 fixtures

Sanerte respons-fasonger for `https://rest.runpod.io/v1`, brukt som felles
kontraktsgrunnlag av server (`server/src/lib/compute/runpodSchemas.ts`),
koordinatoren (`coordinator/src/runpod-v2.js`) og watchdog-testene.

Sanering:

- Alle id-er, navn, IP-er og digests er fabrikerte plassholdere.
- Alle `env`-verdier er erstattet med `"[redacted]"`. Ingen tokens,
  callback-URL-er eller miljøhemmeligheter lagres her.
- Feltutvalget og feltnavnene (bl.a. `imageName`, ikke `image`) speiler
  live-responser observert under kjøringene 2026-08-30 til 2026-09-01
  (se commit 0fb9cad og b7e126c). Refresh fasongene ved neste live-kjøring
  hvis provideren endrer kontrakten.

Filer:

- `pod-gpu.json` — GET `/pods/{id}?includeMachine=true` for en GPU-Pod;
  også fasongen til 201-kroppen fra POST `/pods`.
- `pod-cpu.json` — samme for en CPU-Pod (cache-prewarm).
- `pod-list.json` — GET `/pods`; inneholder med vilje en urelatert Pod med
  ugyldig kostfelt, slik at testene låser inn garantien om at navnefiltrert
  recovery aldri blokkeres av en irrelevant Pod.
- DELETE `/pods/{id}` returnerer 204 uten kropp og trenger ingen fixture.
