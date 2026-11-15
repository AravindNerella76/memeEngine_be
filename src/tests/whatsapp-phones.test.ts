/**
 * Several phone numbers may use the WhatsApp bot. One setting holds them all as a comma-separated list;
 * a single number behaves exactly as before.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedPhone, MAX_ALLOWED_PHONES, normalizePhoneList, parsePhoneList } from '../config/phone-list';
import { loadConfig, setConfigForTests } from '../config/app-config';
import { WhatsAppService } from '../services/whatsapp.service';

const A = '919347708120';
const B = '918885550123';
const C = '14155550100';

describe('parsePhoneList (what a person types in the app)', () => {
  it('reads one number exactly as before, ignoring spaces, plus signs and dashes', () => {
    assert.deepEqual(parsePhoneList('+91 93477-08120').phones, [A]);
    assert.deepEqual(parsePhoneList(A), { phones: [A], invalid: [], tooMany: false });
  });
  it('reads several numbers separated by commas, semicolons or new lines', () => {
    assert.deepEqual(parsePhoneList(`${A}, ${B}`).phones, [A, B]);
    assert.deepEqual(parsePhoneList(`${A};${B}\n${C}`).phones, [A, B, C]);
    assert.deepEqual(parsePhoneList(`+91 93477 08120,\r\n  +91 88855 50123 ,`).phones, [A, B]);
  });
  it('does NOT split on spaces: spaces belong to one formatted number', () => {
    assert.deepEqual(parsePhoneList('+91 93477 08120').phones, [A]);
  });
  it('drops duplicates (however they are formatted) and ignores empty pieces', () => {
    assert.deepEqual(parsePhoneList(`${A},+91 93477-08120,,${A}`).phones, [A]);
  });
  it('reports the entries that are not 8-15 digits so they can be fixed', () => {
    const r = parsePhoneList(`${A}, 12345, ${'9'.repeat(16)}`);
    assert.deepEqual(r.phones, [A]);
    assert.deepEqual(r.invalid, ['12345', '9'.repeat(16)]);
  });
  it('a missing comma shows up as one too-long entry instead of silently merging two numbers', () => {
    const r = parsePhoneList(`${A} ${B}`);
    assert.deepEqual(r.phones, []);
    assert.equal(r.invalid.length, 1);
  });
  it('flags more than the limit', () => {
    const many = Array.from({ length: MAX_ALLOWED_PHONES + 1 }, (_, i) => `9100000000${String(i).padStart(2, '0')}`).join(',');
    assert.equal(parsePhoneList(many).tooMany, true);
    assert.equal(parsePhoneList(many.split(',').slice(0, MAX_ALLOWED_PHONES).join(',')).tooMany, false);
  });
  it('treats non-text input as nothing', () => {
    for (const bad of [undefined, null, 42, { a: 1 }, ['x']]) assert.deepEqual(parsePhoneList(bad), { phones: [], invalid: [], tooMany: false });
  });
});

describe('normalizePhoneList (the server .env)', () => {
  it('is the old behaviour for one number', () => {
    assert.equal(normalizePhoneList('+91 93477-08120'), A);
    assert.equal(normalizePhoneList(''), '');
    assert.equal(normalizePhoneList(undefined), '');
  });
  it('keeps several numbers, comma-separated and without duplicates', () => {
    assert.equal(normalizePhoneList(`${A} , +91 88855 50123;${A}`), `${A},${B}`);
  });
  it('caps the list', () => {
    const many = Array.from({ length: 25 }, (_, i) => `9100000000${String(i).padStart(2, '0')}`).join(',');
    assert.equal(normalizePhoneList(many).split(',').length, MAX_ALLOWED_PHONES);
  });
});

describe('isAllowedPhone (who may use the bot)', () => {
  const list = `${A},${B}`;
  it('accepts each listed number and nobody else', () => {
    assert.equal(isAllowedPhone(list, A), true);
    assert.equal(isAllowedPhone(list, B), true);
    assert.equal(isAllowedPhone(list, C), false);
  });
  it('matches whole numbers only: a prefix, suffix or join of two never gets in', () => {
    assert.equal(isAllowedPhone(list, '91934770'), false);
    assert.equal(isAllowedPhone(list, '347708120'), false);
    assert.equal(isAllowedPhone(list, `${A},${B}`), false);
    assert.equal(isAllowedPhone(list, `${A}${B}`), false);
  });
  it('fails closed on an empty list or a bad sender', () => {
    for (const l of ['', null, undefined]) assert.equal(isAllowedPhone(l as any, A), false);
    for (const f of ['', undefined, null, 5, {}, ' ']) assert.equal(isAllowedPhone(list, f), false);
  });
  it('single-number lists work as before', () => {
    assert.equal(isAllowedPhone(A, A), true);
    assert.equal(isAllowedPhone(A, B), false);
  });
});

describe('configuration', () => {
  it('reads several numbers from WHATSAPP_ALLOWED_PHONE and keeps one number unchanged', () => {
    assert.equal(loadConfig({ WHATSAPP_ALLOWED_PHONE: `+91 93477-08120, ${B}` } as any).whatsapp.allowedPhone, `${A},${B}`);
    assert.equal(loadConfig({ WHATSAPP_ALLOWED_PHONE: '+91 93477-08120' } as any).whatsapp.allowedPhone, A);
    assert.equal(loadConfig({} as any).whatsapp.allowedPhone, '');
  });
});

describe('the bot answers every allowed number and refuses the rest', () => {
  before(() => setConfigForTests(loadConfig({ WHATSAPP_ALLOWED_PHONE: `${A},${B}` } as any)));
  after(() => setConfigForTests(null));

  function bot() {
    const sent: Array<{ to: string; text: string }> = [];
    const sessions = new Map<string, any>();
    const model: any = {
      findOne: async (q: any) => sessions.get(q.phoneNumber) || null,
      create: async (d: any) => {
        const doc = { state: 'IDLE', mode: 'viral', manualSubjects: [], ...d, async save() { return this; } };
        sessions.set(d.phoneNumber, doc);
        return doc;
      }
    };
    const svc: any = new WhatsAppService(model, {} as any, {} as any, {} as any, {} as any, { list: async () => [], get: async () => null, getByPosition: async () => null, markUsed: async () => {} } as any);
    svc.sendTextMessage = async (to: string, text: string) => (sent.push({ to, text }), true);
    return { sent, sessions, say: (from: string, body: string) => svc.handleUserMessage(from, { type: 'text', text: { body } }) };
  }

  it('lets both allowed numbers in, each with its own conversation', async () => {
    const b = bot();
    await b.say(A, 'help');
    await b.say(B, 'help');
    assert.deepEqual([...b.sessions.keys()].sort(), [A, B].sort());
    assert.ok(b.sent.some(m => m.to === A) && b.sent.some(m => m.to === B), 'each got a reply');
    assert.ok(b.sent.every(m => !m.text.includes('authorized users only')));
  });

  it('refuses everyone else with the "authorized users only" message and starts no conversation', async () => {
    const b = bot();
    await b.say(C, 'help');
    assert.equal(b.sessions.size, 0);
    assert.deepEqual(b.sent.map(m => m.to), [C]);
    assert.match(b.sent[0].text, /authorized users only/);
  });
});
