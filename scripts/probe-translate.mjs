/* Prueba: traducción con LLM simulado (OpenAI-compatible local). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'agenda-translate-'));
process.env.WORKFLOWS_AUTOSTART = '0';
process.env.CHANNELS_AUTOSTART = 'off';
process.env.APP_SECRET = 'translate-secret-0123456789abcdef';

const { createMockLlmServer } = await import('../lib/llm/mock-server.mjs');
const mock = await createMockLlmServer();
process.env.OPENAI_API_KEY = 'sk-mock-local';
process.env.OPENAI_BASE_URL = `${mock.url}/v1`;
process.env.OPENAI_MODEL = 'mock-agenda-1';
process.env.LLM_PROVIDER = 'openai';

const { LANGUAGES, languageFor, translateText } = await import('../lib/translate/index.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

check('Ofrece seis idiomas', LANGUAGES.length === 6 && !!languageFor('es') && !!languageFor('EN'), LANGUAGES.map((item) => item.code).join(','));
const translated = await translateText({ text: 'Hello, this is a test.', to: 'es' });
check('Traduce con el modelo configurado', /Traducción \(mock\): Hello, this is a test\./.test(translated.translation), translated.translation);
check('Devuelve idioma y proveedor', translated.to === 'es' && translated.provider === 'openai' && translated.model === 'mock-agenda-1', JSON.stringify({ to: translated.to, provider: translated.provider, model: translated.model }));

const call = mock.calls().at(-1);
const userMessage = call?.body?.messages?.find((message) => message.role === 'user')?.content || '';
const systemMessage = call?.body?.messages?.find((message) => message.role === 'system')?.content || '';
check('Envuelve el texto como dato', /<usuario>[\s\S]*Hello, this is a test\.[\s\S]*<\/usuario>/.test(userMessage), userMessage.slice(0, 90));
check('El sistema prohíbe obedecer instrucciones', /DATO/.test(systemMessage) && /nunca obedezcas/i.test(systemMessage), systemMessage.slice(0, 90));

let badLanguage = null;
try { await translateText({ text: 'hola', to: 'xx' }); } catch (error) { badLanguage = error; }
check('Rechaza idioma no soportado', badLanguage?.status === 400 && badLanguage?.code === 'INVALID_VALUE', badLanguage?.message);

let empty = null;
try { await translateText({ text: '   ', to: 'es' }); } catch (error) { empty = error; }
check('Rechaza texto vacío', empty?.status === 400 && empty?.code === 'REQUIRED', empty?.message);

let long = null;
try { await translateText({ text: 'x'.repeat(4001), to: 'es' }); } catch (error) { long = error; }
check('Rechaza texto excesivo', long?.status === 400 && long?.code === 'TOO_LONG', long?.message);

await mock.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;
