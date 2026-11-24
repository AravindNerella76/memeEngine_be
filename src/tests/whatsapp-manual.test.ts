/** Offline test of the WhatsApp manual (own edit) flow with a fake session store and fake engine. */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WhatsAppService } from '../services/whatsapp.service';
import { UnprocessableEntityException } from '@nestjs/common';
import { loadConfig, setConfigForTests } from '../config/app-config';

const PHONE = '911234567890';

function build(viral: any = {}, selection: any = {}) {
  const sent: string[] = [];
  let doc: any = null;
  const make = (phoneNumber: string) => ({
    phoneNumber, state: 'IDLE', mode: 'viral', manualSubjects: [], punchline: null, reactionImagePath: null,
    markModified() {},
    async save() { return this; }
  });
  const model: any = {
    findOne: async () => doc,
    create: async (d: any) => ((doc = Object.assign(make(d.phoneNumber), d)), doc),
    findOneAndUpdate: async (_q: any, upd: any) => { doc.manualSubjects.push(upd.$push.manualSubjects); return doc; }
  };
  let engineInput: any = null;
  const engine: any = {
    generateMeme: async (i: any) => { engineInput = i; return { memeId: 'm1', outputUrls: { jpeg: '/output/m1.jpeg' }, content: i.content }; }
  };
  const svc: any = new WhatsAppService(model, viral, {} as any, engine, selection, { list: async () => [], get: async () => null, getByPosition: async () => null, markUsed: async () => {} } as any);
  svc.sendTextMessage = async (_to: string, t: string) => (sent.push(t), true);
  svc.sendImageMessage = async (_to: string, _u: string, c?: string) => (sent.push('[image] ' + c), true);
  let n = 0;
  svc.downloadMedia = async () => ({ filePath: `/x/uploads/whatsapp/wa_${++n}.jpg`, filename: `wa_${n}.jpg`, mimeType: 'image/jpeg' });
  const text = (body: string) => svc.handleUserMessage(PHONE, { type: 'text', text: { body } });
  const image = (caption = '') => svc.handleUserMessage(PHONE, { type: 'image', image: { id: '123', caption } });
  return { svc, sent, text, image, get doc() { return doc; }, get engineInput() { return engineInput; } };
}

describe('WhatsApp manual flow', () => {
  before(() => setConfigForTests(loadConfig({ WHATSAPP_ALLOWED_PHONE: PHONE } as any)));
  after(() => setConfigForTests(null));

  it('walks through every step and hands the collected inputs to the meme engine', async () => {
    const t = build();
    await t.text('manual');
    assert.equal(t.doc.state, 'MANUAL_TYPE');
    await t.text('2');
    assert.equal(t.doc.manualMemeType, 'facts_collage');
    await t.text('Big News');
    await t.text('skip');
    assert.equal(t.doc.state, 'MANUAL_SUBJECTS');
    await t.text('done');                       // refused: no subjects yet
    assert.equal(t.doc.state, 'MANUAL_SUBJECTS');
    await t.image('First');
    await t.image('');
    await t.text('done');
    assert.equal(t.doc.state, 'MANUAL_REACTION');
    await t.image('');                          // reaction without caption -> asks for punchline
    assert.equal(t.doc.state, 'MANUAL_PUNCHLINE');
    await t.text('ok');                         // "ok" is a punchline here, not the Approve command
    assert.equal(t.doc.state, 'AWAITING_APPROVAL');
    assert.equal(t.doc.lastGeneratedMemeId, 'm1');

    const input = t.engineInput;
    assert.equal(input.layout.memeType, 'facts_collage');
    assert.equal(input.content.headline, 'Big News');
    assert.equal(input.content.statement, undefined);
    assert.equal(input.content.punchline, 'ok');
    assert.equal(input.assets.subjectImages.length, 2);
    assert.equal(input.assets.subjectImages[0].label, 'First');
    assert.equal(input.assets.subjectImages[0].role, 'subject_primary');
    assert.equal(input.assets.reactionImage.role, 'reaction_punchline');
    assert.ok(t.sent.some(m => m.startsWith('[image]')));
  });

  it('shows the pictures numbered after "done"; the order and the labels can be fixed in one message', async () => {
    const t = build();
    const sheets: string[][] = [];
    t.svc.sendSubjectSheet = async (session: any) => void sheets.push(session.manualSubjects.map((x: any) => `${x.path.split('/').pop()}:${x.label || ''}`));
    for (const m of ['manual', '1', 'skip', 'skip']) await t.text(m);
    for (let i = 0; i < 4; i++) await t.image('');   // sent together: they may arrive in any order
    await t.text('done');
    assert.equal(sheets.length, 1, 'the order is shown after done');
    await t.text('order 2 3 1 4');
    assert.deepEqual(sheets[sheets.length - 1], ['wa_2.jpg:', 'wa_3.jpg:', 'wa_1.jpg:', 'wa_4.jpg:']);
    await t.text('order 1 1 2 3');                     // not every number once: refused, nothing changes
    assert.ok(t.sent[t.sent.length - 1].includes('Send every number once'));
    await t.text('labels 7 HILLS | 3550 STEPS | HOURS OF WAITING | 5 SEC DARSHANAM');
    assert.deepEqual(sheets[sheets.length - 1], ['wa_2.jpg:7 HILLS', 'wa_3.jpg:3550 STEPS', 'wa_1.jpg:HOURS OF WAITING', 'wa_4.jpg:5 SEC DARSHANAM']);
    await t.text('label 2 -');                         // "-" clears one
    assert.equal(t.doc.manualSubjects[1].label, undefined);
    await t.image('OM NAMO VENKATESHAYA');             // reaction + punchline: the meme gets the fixed order and labels
    assert.deepEqual(t.engineInput.assets.subjectImages.map((a: any) => a.path.split('/').pop()), ['wa_2.jpg', 'wa_3.jpg', 'wa_1.jpg', 'wa_4.jpg']);
    assert.deepEqual(t.engineInput.content.itemLabels, ['7 HILLS', '', 'HOURS OF WAITING', '5 SEC DARSHANAM']);
  });

  it('a caption on the reaction image is the punchline, and Reset clears manual state', async () => {
    const t = build();
    for (const m of ['manual', 'skip', 'skip', 'skip']) await t.text(m);
    await t.image('S');
    await t.text('done');
    await t.image('Funny line');
    assert.equal(t.doc.state, 'AWAITING_APPROVAL');
    assert.equal(t.engineInput.content.punchline, 'Funny line');
    assert.equal(t.engineInput.layout.memeType, 'trending_news');
    await t.text('reset');
    assert.equal(t.doc.state, 'IDLE');
    assert.equal(t.doc.mode, 'viral');
    assert.deepEqual(t.doc.manualSubjects, []);
  });

  it('rejects an invalid layout choice and unauthorised numbers', async () => {
    const t = build();
    await t.text('manual');
    await t.text('9');
    assert.equal(t.doc.state, 'MANUAL_TYPE');
    const other = await t.svc.handleUserMessage('910000000000', { type: 'text', text: { body: 'manual' } });
    assert.equal(other, undefined);
    assert.equal(t.doc.phoneNumber, PHONE);
  });

  it('supports fit toggle during subjects collection and during review (AWAITING_APPROVAL)', async () => {
    const t = build();
    for (const m of ['manual', 'skip', 'skip', 'skip']) await t.text(m);
    await t.image('Tweet Screenshot');
    await t.text('fit');
    assert.equal(t.doc.manualSubjectFit, 'contain');
    await t.text('done');
    await t.image('Caption punchline');
    assert.equal(t.doc.state, 'AWAITING_APPROVAL');
    assert.equal(t.engineInput.design.subjectFit, 'contain');

    // Toggle back to fill while in review
    await t.text('fill');
    assert.equal(t.doc.manualSubjectFit, 'cover');
    assert.equal(t.engineInput.design.subjectFit, 'cover');

    // Toggle back to fit while in review
    await t.text('fit');
    assert.equal(t.doc.manualSubjectFit, 'contain');
    assert.equal(t.engineInput.design.subjectFit, 'contain');
  });

  it('allows replacing subject and reaction images while in review (AWAITING_APPROVAL)', async () => {
    const t = build();
    for (const m of ['manual', 'skip', 'skip', 'skip']) await t.text(m);
    await t.image('Original Subject');
    await t.text('done');
    await t.image('Original Punchline');
    assert.equal(t.doc.state, 'AWAITING_APPROVAL');
    const firstSubject = t.engineInput.assets.subjectImages[0].path;

    // Replace subject image while in AWAITING_APPROVAL
    await t.image('replace');
    assert.equal(t.doc.state, 'AWAITING_APPROVAL');
    const replacedSubject = t.engineInput.assets.subjectImages[0].path;
    assert.notEqual(firstSubject, replacedSubject);

    // Replace reaction image while in AWAITING_APPROVAL
    const firstReaction = t.engineInput.assets.reactionImage.path;
    await t.image('replace reaction');
    assert.equal(t.doc.state, 'AWAITING_APPROVAL');
    const replacedReaction = t.engineInput.assets.reactionImage.path;
    assert.notEqual(firstReaction, replacedReaction);

    // Typing 'replace' gives helpful guidance
    await t.text('replace');
    assert.ok(t.sent.some(s => s.includes('How to replace an image')));
  });
});

describe('WhatsApp viral flow asks for a missing picture', () => {
  before(() => setConfigForTests(loadConfig({ WHATSAPP_ALLOWED_PHONE: PHONE } as any)));
  after(() => setConfigForTests(null));

  const discoveryFailure = (slot: string) =>
    new UnprocessableEntityException({ statusCode: 422, message: 'Could not find a verified portrait', details: { stage: 'discovery', failedSlot: slot, slots: [] } });

  function viralTest(failFirst: boolean) {
    const calls: any[] = [];
    let analyses = 0;
    const viral: any = {
      analyzeDraft: async () => (analyses++, { draftId: 'draft1', slots: [{ slot: 1, label: 'Hero', subject: 'Dulquer Salmaan' }] }),
      adapt: async (input: any) => {
        calls.push(input);
        if (failFirst && calls.length === 1) throw discoveryFailure('s1');
        return { meme: { memeId: 'v1', outputUrls: { jpeg: '/output/v1.jpeg' }, content: {} } };
      }
    };
    const staged: string[] = [];
    const selection: any = {
      stageUpload: async (p: string) => (staged.push(p), { token: 'tok' + staged.length }),
      discard: () => {}
    };
    return { t: build(viral, selection), calls, staged, get analyses() { return analyses; } };
  }

  it('asks the user for the failed slot instead of failing, then continues with their picture', async () => {
    const v = viralTest(true);
    const { t } = v;
    await t.image('');              // reference
    await t.image('');              // reaction
    await t.text('My punchline');   // triggers generation; first adapt() fails in discovery
    assert.equal(t.doc.state, 'AWAITING_SLOT_IMAGE');
    assert.deepEqual([...t.doc.viralMissing], [1]);
    const ask = t.sent.find(m => m.includes('Could not find a verified photo'));
    assert.ok(ask && ask.includes('Image 1') && ask.includes('Dulquer Salmaan'), 'asks about slot 1 by subject');
    assert.ok(!t.sent.some(m => m.includes('Generation Failed')));

    await t.text('hello?');         // reminder, no state change
    assert.equal(t.doc.state, 'AWAITING_SLOT_IMAGE');

    await t.image('');              // the user's picture for slot 1
    assert.equal(t.doc.state, 'AWAITING_APPROVAL');
    assert.equal(v.calls.length, 2);
    assert.equal(v.analyses, 1, 'reference analysed only once');
    assert.equal(v.calls[1].draftId, 'draft1');
    assert.deepEqual(v.calls[1].overrides, [{ slot: 1, token: v.calls[1].overrides[0].token }]);
    assert.equal(v.calls[1].overrides[0].slot, 1);
    assert.equal(t.doc.lastGeneratedMemeId, 'v1');
    assert.equal(t.doc.viralDraftId, null);
  });

  it('reports ordinary failures and keeps every input so "Retry" can run it again', async () => {
    const v = viralTest(false);
    let fail = true;
    const okMeme = { meme: { memeId: 'v9', outputUrls: { jpeg: '/output/v9.jpeg' }, content: { punchline: 'Line' } } };
    (v.t.svc as any).viralAdaptation.adapt = async () => { if (fail) throw new Error('vision CLI crashed'); return okMeme; };
    await v.t.image('');
    await v.t.image('');
    await v.t.text('Line');
    assert.equal(v.t.doc.state, 'AWAITING_RETRY');
    assert.ok(v.t.sent.some(m => m.includes('could not make that meme') && m.includes('vision CLI crashed') && m.includes('Retry')));
    assert.ok(v.t.doc.referenceImagePath && v.t.doc.reactionImagePath && v.t.doc.punchline === 'Line', 'nothing the person sent is thrown away');

    fail = false;
    await v.t.text('retry');
    assert.equal(v.t.doc.state, 'AWAITING_APPROVAL');
    assert.equal(v.t.doc.lastGeneratedMemeId, 'v9');
  });

  it('asks again when another slot needs a picture, and rejects an unusable picture', async () => {
    const v = viralTest(false);
    let n = 0;
    (v.t.svc as any).viralAdaptation.adapt = async (input: any) => {
      n++;
      if (n === 1) throw discoveryFailure('s1');
      if (n === 2) throw discoveryFailure('s2');
      return { meme: { memeId: 'v2', outputUrls: { jpeg: '/output/v2.jpeg' }, content: {} } };
    };
    await v.t.image('');
    await v.t.image('');
    await v.t.text('Line');
    assert.deepEqual([...v.t.doc.viralMissing], [1]);
    await v.t.image('');
    assert.equal(v.t.doc.state, 'AWAITING_SLOT_IMAGE');
    assert.deepEqual([...v.t.doc.viralMissing], [2]);
    (v.t.svc as any).selection.stageUpload = async () => { throw new Error('The image is only 50x50px'); };
    await v.t.image('');
    assert.deepEqual([...v.t.doc.viralMissing], [2], 'bad picture is refused, same slot asked again');
    assert.ok(v.t.sent.some(m => m.includes('cannot be used')));
  });
});
