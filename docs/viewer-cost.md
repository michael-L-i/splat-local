# Viewer cost: why the frame loop stopped drawing every frame

An idle viewer used to cost exactly as much as a moving one. `viewer/core.js` called
`renderer.render()` on every `requestAnimationFrame` tick unconditionally, so a scene
nobody was touching was redrawn 120 times a second, forever. On a 120 Hz laptop that is
~86% of every second spent re-rendering an image that had not changed.

It is now demand-driven: the loop still ticks, but it draws only when something actually
changed. This is the measurement behind that.

## The numbers

Chrome, 120 Hz display, 2x device pixel ratio, the 135,575-splat demo scene
(`site/scenes/home.sog`) on the demo viewer page. "Draws/sec" is
`window.__splatRig.framesDrawn` sampled over multi-second windows; the loop itself keeps
ticking at ~120 Hz throughout, which is the point — ticks are free, draws are not.

| state | draws/sec before | draws/sec after |
|---|---|---|
| idle, scene loaded | 120 | 5 |
| dragging the camera | 120 | 84–100 |
| damping glide after release | 120 | ~100 |
| canvas scrolled off screen | 120 | 0 |
| page hidden (other Space, minimised, background tab) | 120 | 0 |

**96% fewer frames at rest, with interaction unchanged.** The "before" column is not an
estimate — `?render=always` restores the old unconditional loop, and it measures 120 both
idle and hidden.

Interaction latency is unaffected. Time from a scene change to the frame that shows it:

| | time to next drawn frame |
|---|---|
| after `invalidate()` | 6 ms (the next tick) |
| no change, waiting on the idle heartbeat | 200 ms |

## Why there is a heartbeat at all

The obvious implementation draws zero frames when idle. This one draws five per second,
and the reason is worth keeping.

The loop can only skip a frame if it knows nothing changed, and it cannot know that.
Spark decodes and depth-sorts splats asynchronously inside a minified vendor bundle; the
camera not having moved does not prove the picture on screen is final. Any missed signal
in a strictly-zero design shows a stale or half-loaded frame until the user happens to
jiggle the mouse — the classic on-demand rendering bug, and a miserable one to diagnose.

Two guards make a missed signal cheap instead of visible:

- `SETTLE_FRAMES` (3) — keep drawing briefly past the last known change, so async work
  landing just after it still reaches the screen.
- `IDLE_HZ` (5) — a floor, not a target. Anything missed self-corrects within 200 ms.

The heartbeat costs ~4% of the old always-on load. That is a good trade for turning a
whole bug class into a barely-perceptible delay.

## Limits of these measurements

- **Frames drawn is a proxy for GPU cost, not a power measurement.** No wattage was
  measured. The claim is 24x fewer rendered frames at rest, and that each frame costs what
  it always did; it is not a measured fan-noise or battery-life figure.
- **The Page Visibility path was verified against a synthetic event.** Headless Chrome
  reports every page as `visible` even when another tab is foregrounded, so a real tab
  switch could not be tested here. The handler was verified by overriding
  `document.visibilityState` and dispatching `visibilitychange`: 0 frames drawn across
  3 seconds hidden, immediate resume. Real browsers additionally stop serving
  `requestAnimationFrame` to hidden documents, so this path is partly belt-and-braces.
- **`IntersectionObserver` rarely fires on the desktop landing page.** The hero canvas is
  taller than the page's total scroll range (612 px document against a 420 px viewport in
  one test), so it never fully leaves the viewport at desktop sizes. The path is verified —
  forced fully off screen, it draws 0 — but the case it was written for mostly does not
  occur there. It does fire on mobile widths, where the canvas starts *below* the fold and
  is paused until scrolled to.
- **The landing hero sways until first interaction**, so it legitimately draws at full rate
  whenever it is visible and untouched. Only the demo viewer page and the in-app viewer go
  quiet at rest immediately. The sway stops for good on first deliberate input, after which
  the landing page idles at 5 too.

## What this does not address

Cost *while the scene is moving* is untouched, and that is deliberate. It is dominated by
pixel ratio: the same scene costs 1.39 ms/frame at 1x, 4.04 ms at 1.5x and 7.19 ms at 2x —
fragment-bound, linear in pixel count. Turning that down was tried before and reverted
because it softens the image exactly while the scene is being looked at. Demand-driven
drawing makes that trade-off smaller anyway: at rest the resolution of a frame that never
gets drawn does not matter.

Spark's LOD is on (`lod: 1.5`) but does not currently engage at this scene size —
`lodSplatCount` is 1.5e6 on desktop against a ~135k-splat scene, so the budget is ~11x the
whole scene. Not a cost, just not yet a saving.

## Debugging a viewer that looks frozen

If a scene ever appears stale or half-loaded, that is a missing `invalidate()`, and the
flag tells you so in one step:

```
?render=always     # restores the old unconditional loop
```

If the flag fixes it, some code changed the scene without announcing it — add
`rig.invalidate()` there. Front ends must call it whenever they add, remove, or hide
anything, or move the camera outside `OrbitControls`.

`window.__splatRig.framesDrawn`, read twice a few seconds apart, is the quickest check
that an idle viewer has actually gone quiet.
