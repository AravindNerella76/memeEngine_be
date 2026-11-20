/**
 * The WhatsApp chat behaves like a reliable assistant: messages are handled in the order they were sent, the chat stays
 * responsive while a meme is made, progress is told as it happens, a restart or failure never leaves the chat stuck,
 * nothing is published by a casual "ok", and a finished meme has Publish / Change punchline / Discard.
 * Meta's API, the pipeline and the database are replaced by fakes.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WhatsAppService } from '../services/whatsapp.service';
import { loadConfig, setConfigForTests } from '../config/app-config';

const PHONE = '911234567890';
const wait = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));

interface Held { release: (meme?: any) => void; fail: (e: Error) => void }

function harness() {
  const sent: string[] = [];
  const buttonMessages: { body: string; buttons: string[]; image: boolean }[] = [];
  const typing: (string | undefined)[] = [];
  const published: { id: string; caption: string }[] = [];
  const punchlineChanges: { id: string; text: string }[] = [];
  let doc: any = null;
  let failNextLookup = false;
  const make = (phoneNumber: string) => ({
    phoneNumber, state: 'IDLE', mode: 'viral', manualSubjects: [] as any[], punchline: null as any, reactionImagePath: null as any, referenceImagePath: null as any,
    viralOverrides: [] as any[], viralSlots: [] as any[], viralMissing: [] as any[], async save() { return this; }
  });
  const model: any = {
    findOne: async () => { if (failNextLookup) { failNextLookup = false; throw new Error('database unavailable'); } return doc; },
    create: async (d: any) => ((doc = Object.assign(make(d.phoneNumber), d)), doc),
    findOneAndUpdate: async (_q: any, upd: any) => { doc.manualSubjects.push(upd.$push.manualSubjects); return doc; }
  };

  // a pipeline that stays "busy" until the test lets it finish, reporting progress the way the real one does
  let held: Held | null = null;
  let adaptCalls = 0;
  const viral: any = {
    analyzeDraft: async () => ({ draftId: 'draft1', slots: [{ slot: 1, subject: 'Mahesh Babu' }, { slot: 2, subject: 'Allu Arjun' }] }),
    adapt: (input: any) => {
      adaptCalls++;
      const say = input.onProgress;
      say?.({ type: 'stage', stage: 'analysis', state: 'skipped' });
      say?.({ type: 'stage', stage: 'identity', state: 'done', note: 'Mahesh Babu · Allu Arjun' });
      say?.({ type: 'slots', slots: [{ slotId: 's1', index: 0, subject: 'Mahesh Babu' }, { slotId: 's2', index: 1, subject: 'Allu Arjun' }] });
      say?.({ type: 'slot', slotId: 's1', state: 'found' });
      say?.({ type: 'slot', slotId: 's2', state: 'found' });
      say?.({ type: 'stage', stage: 'discovery', state: 'done', note: '2 verified' });
      return new Promise((resolve, reject) => {
        held = { release: (meme?: any) => resolve({ meme: meme || { memeId: `m${adaptCalls}`, outputUrls: { jpeg: '/output/m.jpeg' }, content: { headline: 'HEAD', punchline: input.punchline } } }), fail: reject };
      });
    }
  };
  const engine: any = {
    changePunchline: async (id: string, text: string) => (punchlineChanges.push({ id, text }), { memeId: id, outputUrls: { jpeg: '/output/m.jpeg' }, content: { headline: 'HEAD', punchline: text.trim() } })
  };
  const publisher: any = { publishMeme: async (id: string, _v: any, caption: string) => (published.push({ id, caption }), { username: 'kanyaraasi_memes', permalink: 'https://instagram.test/p/1' }) };
  const selection: any = { stageUpload: async () => ({ token: 't' }), discard: () => {} };
  const svc: any = new WhatsAppService(model, viral, publisher, engine, selection, { list: async () => [], get: async () => null, getByPosition: async () => null, markUsed: async () => {} } as any);

  svc.sendTextMessage = async (_to: string, t: string) => (sent.push(t), true);
  svc.sendImageMessage = async (_to: string, _u: string, c?: string) => (sent.push('[image] ' + c), true);
  svc.sendPicture = async (_to: string, _p: any, c?: string) => (sent.push('[image] ' + c), true);
  svc.sendButtonsMessage = async (_to: string, body: string, buttons: any[]) => (buttonMessages.push({ body, buttons: buttons.map(b => b.id), image: false }), true);
  svc.sendImageWithButtons = async (_to: string, _p: any, body: string, buttons: any[]) => (buttonMessages.push({ body, buttons: buttons.map(b => b.id), image: true }), true);
  svc.markReadTyping = async (id?: string) => void typing.push(id);
  const delays = new Map<string, number>();
  svc.downloadMedia = async (id: string) => {
    await wait(delays.get(id) ?? 0);
    return { filePath: `/x/uploads/whatsapp/wa_${id}.jpg`, filename: `wa_${id}.jpg`, mimeType: 'image/jpeg', width: 600, height: 800 };
  };

  let n = 0;
  const msg = (m: any) => ({ id: `wamid.${++n}`, from: PHONE, ...m });
  const hook = (...messages: any[]) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: messages.map(msg) } }] }] });
  const text = (body: string) => svc.processIncomingWebhook(hook({ type: 'text', text: { body } }));
  const tap = (id: string) => svc.processIncomingWebhook(hook({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'x' } } }));

  /** A chat that has everything a viral meme needs, waiting for the punchline. */
  const ready = () => {
    doc = Object.assign(make(PHONE), { state: 'AWAITING_PUNCHLINE', referenceImagePath: '/x/ref.jpg', reactionImagePath: '/x/rx.jpg' });
  };
  /** A chat with a finished meme waiting for approval. */
  const reviewing = (over: any = {}) => {
    doc = Object.assign(make(PHONE), { state: 'AWAITING_APPROVAL', lastGeneratedMemeId: 'm1', lastGeneratedCaption: 'The caption', punchline: 'Old line', ...over });
  };

  return {
    svc, sent, buttonMessages, typing, published, punchlineChanges, delays, hook, text, tap, ready, reviewing,
    get doc() { return doc; }, set doc(d) { doc = d; },
    get held() { return held as Held; }, get adaptCalls() { return adaptCalls; },
    failNextLookup: () => (failNextLookup = true)
  };
}

describe('WhatsApp flow', () => {
  before(() => setConfigForTests(loadConfig({ WHATSAPP_ALLOWED_PHONE: PHONE } as any)));
  after(() => setConfigForTests(null));

  describe('messages are handled in the order they were sent', () => {
    it('keeps manual subject pictures in send order even when their downloads finish out of order', async () => {
      const h = harness();
      h.doc = Object.assign({ phoneNumber: PHONE, state: 'MANUAL_SUBJECTS', mode: 'manual', manualSubjects: [], async save() { return this; } });
      // the first picture is the slowest to download: handled at the same time, it would be saved last
      h.delays.set('1', 60);
      h.delays.set('2', 30);
      h.delays.set('3', 0);
      await h.svc.processIncomingWebhook(h.hook(
        { type: 'image', image: { id: '1', caption: 'First' } },
        { type: 'image', image: { id: '2', caption: 'Second' } },
        { type: 'image', image: { id: '3', caption: 'Third' } }
      ));
      assert.deepEqual(h.doc.manualSubjects.map((s: any) => s.label), ['First', 'Second', 'Third']);
      assert.deepEqual(h.doc.manualSubjects.map((s: any) => s.path.split('wa_')[1]), ['1.jpg', '2.jpg', '3.jpg']);
    });

    it('also keeps order when the messages arrive in separate webhook calls at the same time', async () => {
      const h = harness();
      h.doc = Object.assign({ phoneNumber: PHONE, state: 'MANUAL_SUBJECTS', mode: 'manual', manualSubjects: [], async save() { return this; } });
      h.delays.set('1', 50);
      h.delays.set('2', 0);
      const a = h.svc.processIncomingWebhook(h.hook({ type: 'image', image: { id: '1', caption: 'A' } }));
      const b = h.svc.processIncomingWebhook(h.hook({ type: 'image', image: { id: '2', caption: 'B' } }));
      await Promise.all([a, b]);
      assert.deepEqual(h.doc.manualSubjects.map((s: any) => s.label), ['A', 'B']);
    });

    it('one message that fails is answered, and the next one is still handled', async () => {
      const h = harness();
      h.failNextLookup();
      await h.svc.processIncomingWebhook(h.hook({ type: 'text', text: { body: 'hello' } }, { type: 'text', text: { body: 'status' } }));
      assert.ok(h.sent.some(m => m.includes('Something went wrong')), 'the person is told');
      assert.ok(h.sent.some(m => m.includes('📊')), 'the next message was handled');
    });
  });

  describe('while a meme is being made', () => {
    it('answers status and other messages at once, tells progress in order, then delivers the meme', async () => {
      const h = harness();
      h.ready();
      const making = h.text('My punchline');
      await wait();
      assert.equal(h.doc.state, 'GENERATING');

      // the chat is not frozen: these are answered while the pipeline is still busy
      await h.text('status');
      assert.ok(h.sent.some(m => m.includes('Making your meme') && m.includes('📊')), 'status says what is happening, in words');
      assert.ok(!h.sent.some(m => m.includes('GENERATING')), 'never the internal state name');
      await h.text('are you there?');
      assert.ok(h.sent.some(m => m.includes('Still making your meme')), 'no silence');
      await h.svc.processIncomingWebhook(h.hook({ type: 'image', image: { id: '9' } }));
      assert.ok(h.sent.some(m => m.includes('making your meme right now')), 'a picture sent meanwhile is explained, not swallowed');
      assert.equal(h.buttonMessages.length, 0, 'the meme is not here yet');

      h.held.release();
      await making;
      assert.equal(h.doc.state, 'AWAITING_APPROVAL');
      assert.equal(h.buttonMessages.length, 1);
      assert.deepEqual(h.buttonMessages[0].buttons, ['pub:m1', 'pl:m1', 'no:m1']);

      // real stages, told once each and always before the meme
      const told = h.sent.filter(m => /Reading your reference|know who is who|Picture 1 of 2|All pictures found/.test(m));
      assert.equal(told.length, 4, told.join(' | '));
      assert.match(told[0], /Reading your reference/);
      assert.match(told[1], /Mahesh Babu · Allu Arjun/);
      assert.match(told[2], /Picture 1 of 2 found: Mahesh Babu/);
      assert.match(told[3], /Setting your punchline/);
      assert.ok(!h.sent.some(m => /Picture 2 of 2/.test(m)), 'the last picture is announced by "all found", not twice');
    });

    it('promises minutes, not seconds', async () => {
      const h = harness();
      h.ready();
      const making = h.text('Line');
      await wait();
      assert.ok(h.sent.some(m => /2–4 minutes/.test(m)));
      assert.ok(!h.sent.some(m => /30-60s/.test(m)));
      h.held.release();
      await making;
    });

    it('Reset stops it: the finished meme is dropped, not delivered into the fresh chat', async () => {
      const h = harness();
      h.ready();
      const making = h.text('Line');
      await wait();
      await h.text('reset');
      assert.equal(h.doc.state, 'IDLE');
      assert.ok(h.sent.some(m => m.includes('Stopped')));
      h.held.release();
      await making;
      assert.equal(h.doc.state, 'IDLE', 'the late result did not bring the old meme back');
      assert.equal(h.buttonMessages.length, 0);
      assert.ok(!h.sent.some(m => m.startsWith('[image]')));
    });

    it('a failure keeps the inputs; Retry or a new punchline runs it again', async () => {
      const h = harness();
      h.ready();
      const making = h.text('First line');
      await wait();
      h.held.fail(new Error('the AI is down'));
      await making;
      assert.equal(h.doc.state, 'AWAITING_RETRY');
      assert.ok(h.sent.some(m => m.includes('the AI is down') && m.includes('Retry')));
      assert.ok(h.doc.referenceImagePath && h.doc.reactionImagePath && h.doc.punchline === 'First line');

      const again = h.text('what now'); // any other text is a new punchline
      await wait();
      assert.equal(h.doc.punchline, 'what now');
      assert.equal(h.doc.state, 'GENERATING');
      h.held.release();
      await again;
      assert.equal(h.doc.state, 'AWAITING_APPROVAL');
    });
  });

  describe('a long wait is never silent', () => {
    it('keeps the typing indicator alive, and says "still working" after a quiet stretch (but not while it is chatty)', async t => {
      try {
        (t.mock.timers.enable as any)({ apis: ['setInterval', 'Date'] });
      } catch {
        // Node 18 mock timers do not support Date mocking; skip on Node 18
        return;
      }
      const h = harness();
      h.svc.lastIncoming.set(PHONE, 'wamid.last');
      const run = h.svc.beginRun(PHONE, 'viral');
      run.stage = 'finding and checking pictures';
      const stop = h.svc.watchRun(PHONE, run);

      t.mock.timers.tick(20_000);
      await wait(0);
      assert.deepEqual(h.typing, ['wamid.last'], 'typing is refreshed while the bot is quiet for a short while');
      assert.equal(h.sent.length, 0, 'no chatter yet');

      t.mock.timers.tick(60_000); // 80 s without a word
      await wait(0);
      assert.ok(h.sent.some(m => /Still working… 1:20 so far, finding and checking pictures/.test(m)), h.sent.join(' | '));

      // having just spoken, the next tick does not repeat itself
      const spoken = h.sent.length;
      t.mock.timers.tick(20_000);
      await wait(0);
      assert.equal(h.sent.length, spoken);

      stop();
      t.mock.timers.tick(200_000);
      await wait(0);
      assert.equal(h.sent.length, spoken, 'stopped means stopped');
    });
  });

  describe('a restart never leaves the chat stuck', () => {
    it('notices a meme that was being made when the server restarted, and offers Retry', async () => {
      const h = harness();
      h.doc = Object.assign(h.doc || {}, { phoneNumber: PHONE, state: 'GENERATING', mode: 'viral', referenceImagePath: '/x/ref.jpg', reactionImagePath: '/x/rx.jpg', punchline: 'Saved line', manualSubjects: [], async save() { return this; } });
      await h.text('hello?');
      assert.equal(h.doc.state, 'AWAITING_RETRY');
      assert.ok(h.sent.some(m => m.includes('lost track') && m.includes('Retry')));

      const again = h.text('retry');
      await wait();
      assert.equal(h.adaptCalls, 1);
      assert.equal(h.doc.punchline, 'Saved line');
      h.held.release();
      await again;
      assert.equal(h.doc.state, 'AWAITING_APPROVAL');
    });

    it('starts clean when there is nothing to retry', async () => {
      const h = harness();
      h.doc = Object.assign({ phoneNumber: PHONE, state: 'GENERATING', mode: 'viral', manualSubjects: [], async save() { return this; } });
      await h.text('anyone there');
      assert.equal(h.doc.state, 'IDLE');
      assert.ok(h.sent.some(m => m.includes('lost track')));
    });

    it('a message after a reset during a run does not mistake the fresh chat for a lost run', async () => {
      const h = harness();
      h.ready();
      const making = h.text('Line');
      await wait();
      await h.text('reset');
      await h.text('hello');
      assert.ok(!h.sent.some(m => m.includes('lost track')));
      h.held.release();
      await making;
    });
  });

  describe('nothing is published by accident', () => {
    it('"ok", "yes" and a thumbs-up under a finished meme do not publish', async () => {
      const h = harness();
      h.reviewing();
      for (const word of ['ok', 'Yes', '👍', 'sure']) await h.text(word);
      assert.equal(h.published.length, 0);
      assert.equal(h.sent.filter(m => /I will not post anything unless you do/.test(m)).length, 4, 'each is answered with how to publish');
      assert.equal(h.doc.state, 'AWAITING_APPROVAL');
    });

    it('"approve" and "publish" still publish, with the full Instagram caption', async () => {
      const h = harness();
      h.reviewing({ lastGeneratedCaption: 'Punch\n\nHEAD\n\nFollow @kanyaraasi_memes for more Telugu memes & comedy! 🎯\n\n#telugumemes' });
      await h.text('Approve');
      assert.equal(h.published.length, 1);
      assert.match(h.published[0].caption, /^Punch[\s\S]*Follow @kanyaraasi_memes[\s\S]*#telugumemes$/);
      assert.equal(h.doc.state, 'IDLE');
      h.reviewing();
      await h.text('publish');
      assert.equal(h.published.length, 2);
    });

    it('"Approve" with nothing waiting says so', async () => {
      const h = harness();
      await h.text('approve');
      assert.equal(h.published.length, 0);
      assert.ok(h.sent.some(m => m.includes('No meme is currently waiting')));
    });

    it('"Caption: ..." sets the caption used when publishing', async () => {
      const h = harness();
      h.reviewing();
      await h.text('Caption: my own words #tag');
      assert.equal(h.doc.lastGeneratedCaption, 'my own words #tag');
      await h.text('approve');
      assert.equal(h.published[0].caption, 'my own words #tag');
    });
  });

  describe('the buttons under a finished meme', () => {
    it('Publish posts it', async () => {
      const h = harness();
      h.reviewing();
      await h.tap('pub:m1');
      assert.equal(h.published.length, 1);
      assert.equal(h.published[0].id, 'm1');
      assert.equal(h.published[0].caption, 'The caption');
    });

    it('a button from an older meme is ignored and explained', async () => {
      const h = harness();
      h.reviewing({ lastGeneratedMemeId: 'm2' });
      await h.tap('pub:m1');
      assert.equal(h.published.length, 0);
      assert.ok(h.sent.some(m => m.includes('older meme')));
      assert.equal(h.buttonMessages.length, 1, 'the current buttons are shown again');
    });

    it('Change punchline asks for the words, applies them as typed, and shows the meme again', async () => {
      const h = harness();
      h.reviewing();
      await h.tap('pl:m1');
      assert.equal(h.doc.state, 'AWAITING_NEW_PUNCHLINE');
      await h.text('  సూపర్ సార్ మీరు  ');
      // only surrounding spaces are removed (as everywhere else); the words themselves are exactly as typed
      assert.deepEqual(h.punchlineChanges, [{ id: 'm1', text: 'సూపర్ సార్ మీరు' }]);
      assert.equal(h.doc.state, 'AWAITING_APPROVAL');
      assert.equal(h.doc.punchline, 'సూపర్ సార్ మీరు');
      assert.equal(h.buttonMessages.length, 1);
      assert.match(h.doc.lastGeneratedCaption, /సూపర్ సార్ మీరు/);
    });

    it('a punchline that is a bot word ("hello") is still taken as the punchline', async () => {
      const h = harness();
      h.reviewing();
      await h.tap('pl:m1');
      await h.text('hello');
      assert.equal(h.punchlineChanges[0].text, 'hello');
    });

    it('"Cancel" while changing the punchline goes back to the meme, it does not throw it away', async () => {
      const h = harness();
      h.reviewing();
      await h.tap('pl:m1');
      await h.text('cancel');
      assert.equal(h.doc.state, 'AWAITING_APPROVAL');
      assert.equal(h.doc.lastGeneratedMemeId, 'm1');
      assert.equal(h.punchlineChanges.length, 0);
    });

    it('a change the engine refuses leaves the meme as it was', async () => {
      const h = harness();
      h.reviewing();
      h.svc.memeEngine.changePunchline = async () => { throw new Error('That already is the punchline of this meme.'); };
      await h.tap('pl:m1');
      await h.text('same');
      assert.equal(h.doc.state, 'AWAITING_APPROVAL');
      assert.ok(h.sent.some(m => m.includes('That already is the punchline')));
    });

    it('Discard clears the chat and says the meme stays in My Memes', async () => {
      const h = harness();
      h.reviewing();
      await h.tap('no:m1');
      assert.equal(h.doc.state, 'IDLE');
      assert.ok(h.sent.some(m => m.includes('My Memes')));
      assert.equal(h.published.length, 0);
    });
  });

  describe('the chat never goes quiet', () => {
    it('free text under a finished meme is answered, with the buttons again', async () => {
      const h = harness();
      h.reviewing();
      await h.text('hmm what');
      assert.ok(h.sent.some(m => m.includes('waiting')));
      assert.equal(h.buttonMessages.length, 1);
    });

    it('voice notes and videos get a reply; an emoji reaction to a message does not', async () => {
      const h = harness();
      await h.svc.processIncomingWebhook(h.hook({ type: 'audio', audio: { id: 'a' } }));
      assert.ok(h.sent.some(m => m.includes('only work with *pictures* and *text*')));
      const before = h.sent.length;
      await h.svc.processIncomingWebhook(h.hook({ type: 'reaction', reaction: { emoji: '👍', message_id: 'x' } }));
      assert.equal(h.sent.length, before);
    });

    it('a picture where none is expected is explained', async () => {
      const h = harness();
      h.doc = Object.assign({ phoneNumber: PHONE, state: 'AWAITING_RETRY', mode: 'viral', manualSubjects: [], async save() { return this; } });
      await h.svc.processIncomingWebhook(h.hook({ type: 'image', image: { id: '5' } }));
      assert.ok(h.sent.some(m => m.includes('Retry')));
    });

    it('status uses plain words, never the internal name', async () => {
      const h = harness();
      h.reviewing();
      await h.text('status');
      assert.ok(h.sent.some(m => m.includes('Your meme is ready and waiting for you')));
      assert.ok(!h.sent.some(m => m.includes('AWAITING_APPROVAL')));
    });

    it('marks each message read with the typing indicator (only messages that have an id)', async () => {
      const h = harness();
      await h.svc.processIncomingWebhook(h.hook({ type: 'text', text: { body: 'hello' } }));
      assert.equal(h.typing.length, 1);
      assert.match(String(h.typing[0]), /^wamid\./);
    });
  });
});
