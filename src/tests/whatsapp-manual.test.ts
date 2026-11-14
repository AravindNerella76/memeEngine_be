/** Offline test of the WhatsApp manual (own edit) flow with a fake session store and fake engine. */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WhatsAppService } from '../services/whatsapp.service';
import { loadConfig, setConfigForTests } from '../config/app-config';

const PHONE = '911234567890';

function build() {
  const sent: string[] = [];
  let doc: any = null;
  const make = (phoneNumber: string) => ({
    phoneNumber, state: 'IDLE', mode: 'viral', manualSubjects: [], punchline: null, reactionImagePath: null,
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
  const svc: any = new WhatsAppService(model, {} as any, {} as any, engine);
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
});
