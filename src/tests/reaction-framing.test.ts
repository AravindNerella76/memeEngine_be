/**
 * Reaction framing: finding the frames of a stacked reaction picture, planning the reaction panel, reading the
 * owner's choice. Pictures are built in code (no files), so the rules are checked exactly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  analyzeReactionImage,
  parseReactionFraming,
  planReactionPanel,
  reactionPanelHeight,
  ReactionAnalysis
} from '../services/reaction-framing';

/** A small deterministic "photo": soft colour blobs on a coloured ground, so it has texture like a movie still. */
function scene(g: any, x: number, y: number, w: number, h: number, hue: number, seed: number) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip(); // a frame never paints outside itself
  g.fillStyle = `hsl(${hue}, 45%, 38%)`;
  g.fillRect(x, y, w, h);
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `hsl(${hue + rnd() * 50}, ${30 + rnd() * 50}%, ${20 + rnd() * 55}%)`; // cool colours only: nothing but the face is skin-coloured
    g.beginPath();
    g.arc(x + rnd() * w, y + rnd() * h, 8 + rnd() * 40, 0, Math.PI * 2);
    g.fill();
  }
  // a "face": a skin-coloured oval
  g.fillStyle = 'rgb(205,150,115)';
  g.beginPath();
  g.ellipse(x + w * 0.72, y + h * 0.32, w * 0.09, h * 0.2, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

async function picture(build: (g: any) => void, w = 400, h = 400) {
  const c = createCanvas(w, h);
  build(c.getContext('2d'));
  return loadImage(c.toBuffer('image/png'));
}

describe('finding the frames of a stacked reaction picture', () => {
  it('finds two frames separated by a dark divider', async () => {
    const img = await picture(g => {
      scene(g, 0, 0, 400, 192, 200, 1);
      g.fillStyle = '#050505';
      g.fillRect(0, 192, 400, 16);
      scene(g, 0, 208, 400, 192, 250, 2);
    });
    const a = analyzeReactionImage(img);
    assert.equal(a.stacked, true);
    assert.equal(a.frames.length, 2);
    assert.ok(Math.abs(a.frames[0].y + a.frames[0].height - 192) <= 12, 'the first frame ends at the divider');
    assert.ok(Math.abs(a.frames[1].y - 208) <= 12, 'the second frame starts after it');
    assert.equal(a.autoFocus.length, 2);
  });

  it('finds two frames that simply touch (no divider)', async () => {
    const img = await picture(g => {
      scene(g, 0, 0, 400, 200, 190, 3);
      scene(g, 0, 200, 400, 200, 270, 4);
    });
    const a = analyzeReactionImage(img);
    assert.equal(a.frames.length, 2);
    assert.ok(Math.abs(a.frames[1].y - 200) <= 8);
  });

  it('finds three frames', async () => {
    const img = await picture(g => {
      scene(g, 0, 0, 400, 133, 190, 5);
      scene(g, 0, 133, 400, 134, 250, 6);
      scene(g, 0, 267, 400, 133, 310, 7);
    }, 400, 400);
    const a = analyzeReactionImage(img);
    assert.equal(a.frames.length, 3);
  });

  it('leaves an ordinary single scene alone', async () => {
    const img = await picture(g => scene(g, 0, 0, 640, 360, 200, 8), 640, 360);
    const a = analyzeReactionImage(img);
    assert.equal(a.stacked, false);
    assert.deepEqual(a.frames, [{ x: 0, y: 0, width: 640, height: 360 }]);
  });

  it('does not take letterbox bars for frames', async () => {
    const img = await picture(g => {
      g.fillStyle = '#000';
      g.fillRect(0, 0, 640, 360);
      scene(g, 0, 50, 640, 260, 200, 9);
    }, 640, 360);
    assert.equal(analyzeReactionImage(img).stacked, false);
  });

  it('suggests the face of each frame (sideways position)', async () => {
    const img = await picture(g => {
      scene(g, 0, 0, 400, 192, 200, 1);
      g.fillStyle = '#050505';
      g.fillRect(0, 192, 400, 16);
      scene(g, 0, 208, 400, 192, 250, 2);
    });
    const a = analyzeReactionImage(img);
    for (const f of a.autoFocus) assert.ok(f.x > 0.55 && f.x < 0.9, `focus x ${f.x} is on the face (right of centre)`);
  });

  it('is quick enough to run on every render', async () => {
    const img = await picture(g => scene(g, 0, 0, 1080, 1080, 60, 10), 1080, 1080);
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) analyzeReactionImage(img);
    assert.ok((performance.now() - t0) / 5 < 60, 'under 60 ms per picture');
  });
});

describe('planning the reaction panel', () => {
  const stack: ReactionAnalysis = {
    width: 480,
    height: 480,
    frames: [
      { x: 0, y: 0, width: 480, height: 240 },
      { x: 0, y: 240, width: 480, height: 240 }
    ],
    stacked: true,
    autoFocus: [{ x: 0.78, y: 0.3 }, { x: 0.25, y: 0.5 }]
  };
  const single: ReactionAnalysis = { width: 480, height: 480, frames: [{ x: 0, y: 0, width: 480, height: 480 }], stacked: false, autoFocus: [{ x: 0.5, y: 0.5 }] };
  const panel = { width: 1080, height: 567 };

  it('shows a stack side by side, columns filling the panel with a gap', () => {
    const plan = planReactionPanel(stack, undefined, panel);
    assert.equal(plan.split, true);
    assert.equal(plan.parts.length, 2);
    const [a, b] = plan.parts;
    assert.equal(a.dest.x, 0);
    assert.equal(b.dest.x + b.dest.width, 1080, 'the last column ends at the panel edge');
    assert.ok(b.dest.x - (a.dest.x + a.dest.width) >= 4, 'there is a gap between the frames');
    assert.ok(a.dest.height === 567 && b.dest.height === 567);
  });

  it('crops each frame around its own focus and stays inside the frame', () => {
    const [a, b] = planReactionPanel(stack, undefined, panel).parts;
    assert.ok(a.src.y >= 0 && a.src.y + a.src.height <= 240 + 0.001, 'first crop is inside the first frame');
    assert.ok(b.src.y >= 240 && b.src.y + b.src.height <= 480 + 0.001, 'second crop is inside the second frame');
    assert.ok(a.src.x + a.src.width / 2 > b.src.x + b.src.width / 2, 'the first face is to the right, the second to the left');
    for (const p of [a, b]) {
      assert.ok(p.src.x >= 0 && p.src.x + p.src.width <= 480 + 0.001);
      assert.ok(Math.abs(p.src.width / p.src.height - p.dest.width / p.dest.height) < 0.01, 'no stretching');
    }
  });

  it('uses the owner\'s focus instead of the suggestion', () => {
    const auto = planReactionPanel(stack, undefined, panel).parts[0].src.x;
    const mine = planReactionPanel(stack, { focus: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] }, panel).parts[0].src.x;
    assert.ok(mine < auto, 'moved to the left');
  });

  it('shows a stack as one picture when told so', () => {
    const plan = planReactionPanel(stack, { split: false }, panel);
    assert.equal(plan.split, false);
    assert.equal(plan.parts.length, 1);
  });

  it('for a single picture with no choice, is exactly the long-standing crop', () => {
    const plan = planReactionPanel(single, undefined, panel, 0.36);
    const p = plan.parts[0];
    // square picture into a wide panel: the full width, a band of height w/aspect, top = excess * anchorY
    const bandH = 480 / (1080 / 567);
    assert.equal(p.src.x, 0);
    assert.ok(Math.abs(p.src.width - 480) < 1e-9 && Math.abs(p.src.height - bandH) < 1e-9);
    assert.ok(Math.abs(p.src.y - (480 - bandH) * 0.36) < 1e-9);
    // a wide picture into the same panel: full height, centred sideways
    const wide: ReactionAnalysis = { width: 1920, height: 800, frames: [{ x: 0, y: 0, width: 1920, height: 800 }], stacked: false, autoFocus: [{ x: 0.5, y: 0.5 }] };
    const w = planReactionPanel(wide, undefined, panel, 0.36).parts[0];
    assert.equal(w.src.y, 0);
    assert.ok(Math.abs(w.src.x - (1920 - 800 * (1080 / 567)) / 2) < 1e-9);
  });

  it('for a single picture with a chosen focus, centres the crop on it', () => {
    const top = planReactionPanel(single, { focus: [{ x: 0.5, y: 0 }] }, panel).parts[0].src;
    const bottom = planReactionPanel(single, { focus: [{ x: 0.5, y: 1 }] }, panel).parts[0].src;
    assert.equal(top.y, 0);
    assert.ok(Math.abs(bottom.y + bottom.height - 480) < 1e-9);
  });

  it('reports how much a small picture is enlarged', () => {
    assert.ok(planReactionPanel(single, undefined, panel).enlargement > 2, '480 px across 1080 px is more than 2x');
    const big: ReactionAnalysis = { width: 2160, height: 1215, frames: [{ x: 0, y: 0, width: 2160, height: 1215 }], stacked: false, autoFocus: [{ x: 0.5, y: 0.5 }] };
    assert.ok(planReactionPanel(big, undefined, panel).enlargement <= 1);
  });

  it('ignores out-of-range focus values from a request', () => {
    const plan = planReactionPanel(single, { focus: [{ x: 9, y: -4 }] }, panel);
    const s = plan.parts[0].src;
    assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.width <= 480 + 0.001 && s.y + s.height <= 480 + 0.001);
  });
});

describe('choosing one frame, or the whole picture', () => {
  const stack: ReactionAnalysis = {
    width: 480,
    height: 480,
    frames: [
      { x: 0, y: 0, width: 480, height: 240 },
      { x: 0, y: 240, width: 480, height: 240 }
    ],
    stacked: true,
    autoFocus: [{ x: 0.78, y: 0.3 }, { x: 0.25, y: 0.5 }]
  };
  const panel = { width: 1080, height: 567 };

  it('one chosen frame fills the whole panel, cropped inside that frame around its face', () => {
    for (const i of [0, 1]) {
      const plan = planReactionPanel(stack, { frame: i }, panel);
      assert.equal(plan.kind, 'frame');
      assert.equal(plan.parts.length, 1);
      const p = plan.parts[0];
      assert.deepEqual(p.dest, { x: 0, y: 0, width: 1080, height: 567 });
      assert.ok(p.src.y >= stack.frames[i].y && p.src.y + p.src.height <= stack.frames[i].y + stack.frames[i].height + 0.001, `inside frame ${i}`);
      assert.ok(Math.abs(p.src.width / p.src.height - 1080 / 567) < 0.01, 'no stretching');
    }
    const a = planReactionPanel(stack, { frame: 0 }, panel).parts[0].src;
    const b = planReactionPanel(stack, { frame: 1 }, panel).parts[0].src;
    assert.ok(a.x > b.x, 'the first frame\'s face is to the right, the second\'s to the left');
  });

  it('the owner\'s focus moves the chosen frame\'s crop', () => {
    const left = planReactionPanel(stack, { frame: 0, focus: [{ x: 0, y: 0.5 }] }, panel).parts[0].src.x;
    const right = planReactionPanel(stack, { frame: 0, focus: [{ x: 1, y: 0.5 }] }, panel).parts[0].src.x;
    assert.ok(left < right);
  });

  it('a frame that does not exist, or a picture that is not a stack, is simply used as one picture', () => {
    assert.equal(planReactionPanel(stack, { frame: 5 }, panel).kind, 'split');
    const single: ReactionAnalysis = { width: 480, height: 480, frames: [{ x: 0, y: 0, width: 480, height: 480 }], stacked: false, autoFocus: [{ x: 0.5, y: 0.5 }] };
    assert.equal(planReactionPanel(single, { frame: 0 }, panel).kind, 'single');
  });

  it('the whole picture is uncropped, centred, with a softened copy of itself behind it', () => {
    const plan = planReactionPanel(stack, { fit: 'whole' }, panel);
    assert.equal(plan.kind, 'whole');
    const p = plan.parts[0];
    assert.deepEqual(p.src, { x: 0, y: 0, width: 480, height: 480 }, 'every pixel is used');
    assert.ok(p.dest.height <= 567 + 1e-9 && p.dest.width <= 1080);
    assert.ok(Math.abs(p.dest.width / p.dest.height - 1) < 1e-9, 'the picture keeps its shape');
    assert.ok(Math.abs(p.dest.x + p.dest.width / 2 - 540) < 1e-6, 'centred');
    assert.ok(plan.background && plan.background.dest.width === 1080 && plan.background.dest.height === 567, 'the backdrop fills the panel');
    assert.ok(plan.enlargement > 1 && plan.enlargement < 1.3, 'a 480 px picture shown 567 px tall is only a little enlarged');
  });

  it('the whole picture works for any picture, stacked or not', () => {
    const wide: ReactionAnalysis = { width: 1920, height: 800, frames: [{ x: 0, y: 0, width: 1920, height: 800 }], stacked: false, autoFocus: [{ x: 0.5, y: 0.5 }] };
    const plan = planReactionPanel(wide, { fit: 'whole' }, panel);
    assert.equal(plan.kind, 'whole');
    assert.ok(Math.abs(plan.parts[0].dest.width - 1080) < 1e-6, 'a wide picture fills the width');
  });

  it('reads and refuses the new choices', () => {
    assert.deepEqual(parseReactionFraming('{"frame":1}'), { frame: 1 });
    assert.deepEqual(parseReactionFraming({ fit: 'whole' }), { fit: 'whole' });
    assert.deepEqual(parseReactionFraming({ frame: 0, focus: [{ x: 0.2, y: 0.4 }] }), { frame: 0, focus: [{ x: 0.2, y: 0.4 }] });
    for (const bad of [{ frame: -1 }, { frame: 3 }, { frame: 1.5 }, { frame: '1' }, { fit: 'stretch' }, { fit: true }, { frame: 0, fit: 'whole' }]) {
      assert.throws(() => parseReactionFraming(bad as any), Error, JSON.stringify(bad));
    }
  });
});

describe('the reaction panel height', () => {
  it('is the picture\'s own shape clamped to 34-42% of the canvas, or the plan\'s ratio', () => {
    assert.equal(reactionPanelHeight(1080, 1350, 1.0), Math.round(1350 * 0.42));
    assert.equal(reactionPanelHeight(1080, 1350, 16 / 9), Math.round(1350 * 0.42) >= 608 ? 608 : Math.round(1350 * 0.42));
    assert.equal(reactionPanelHeight(1080, 1350, 3), Math.round(1350 * 0.34));
    assert.equal(reactionPanelHeight(1080, 1350, 1.0, 0.4), 540);
  });
});

describe('reading the owner\'s framing choice', () => {
  it('accepts JSON text or an object, clamps points, and treats nothing as nothing', () => {
    assert.equal(parseReactionFraming(undefined), undefined);
    assert.equal(parseReactionFraming(''), undefined);
    assert.equal(parseReactionFraming('{}'), undefined);
    assert.deepEqual(parseReactionFraming('{"split":false}'), { split: false });
    assert.deepEqual(parseReactionFraming({ focus: [{ x: 1.5, y: -1 }] }), { focus: [{ x: 1, y: 0 }] });
  });
  it('refuses anything malformed or oversized', () => {
    for (const bad of ['not json', '[]', '5', '{"split":"yes"}', '{"focus":"x"}', '{"focus":[{"x":"a","y":1}]}', '{"focus":[{"x":1}]}', '{"focus":[{"x":0,"y":0},{"x":0,"y":0},{"x":0,"y":0},{"x":0,"y":0}]}', 'x'.repeat(2001), [1], 7]) {
      assert.throws(() => parseReactionFraming(bad as any), Error, String(bad).slice(0, 30));
    }
  });
});
