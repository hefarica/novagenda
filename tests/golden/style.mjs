/** Categoría D: estilo e identidad (10 casos). */
import { prepare, runCategory, assert, equal } from './harness.mjs';

prepare('golden-style-');
const { store } = await import(new URL('../../lib/store.mjs', import.meta.url));
const profileMod = await import(new URL('../../lib/style/profile.mjs', import.meta.url));
const { scoreText } = await import(new URL('../../lib/style/score.mjs', import.meta.url));
const { composeEmail } = await import(new URL('../../lib/style/compose.mjs', import.meta.url));
const { startTestApp, api } = await import(new URL('../helpers/env.mjs', import.meta.url));

const SAMPLES = [
  'Hola Andrés:\n\nGracias por tu mensaje. Reviso el alcance y te confirmo mañana.\n\nUn abrazo,\nHéctor Ramírez\nGerente Comercial',
  'Hola Marta:\n\nPerfecto, queda agendado para el jueves a las 10.\n\nSaludos,\nHéctor Ramírez\nGerente Comercial',
  'Buen día Carlos:\n\nAdjunto la propuesta con los ajustes que comentamos.\n\nCordialmente,\nHéctor Ramírez\nGerente Comercial',
  'Hola Laura:\n\n¿Puedes revisar el informe antes del viernes?\n\nGracias,\nHéctor Ramírez\nGerente Comercial',
  'Hola equipo:\n\nComparto el resumen de la reunión y los próximos pasos.\n\nSaludos,\nHéctor Ramírez\nGerente Comercial',
  'Hola Diego:\n\nQuedo atento a tus comentarios sobre el contrato.\n\nUn abrazo,\nHéctor Ramírez\nGerente Comercial',
  'Hola Ana:\n\nConfirmo la reunión del martes y llevo el acta.\n\nSaludos,\nHéctor Ramírez\nGerente Comercial',
  'Hola Sofía:\n\nGracias por la gestión; el pago quedó programado.\n\nCordialmente,\nHéctor Ramírez\nGerente Comercial',
  'Hola Jorge:\n\nRevisé el presupuesto y te envío observaciones puntuales.\n\nSaludos,\nHéctor Ramírez\nGerente Comercial',
  'Hola Paula:\n\nQuedamos así: cierre el viernes y revisión el lunes.\n\nGracias,\nHéctor Ramírez\nGerente Comercial',
  'Hola Camila:\n\nTe comparto el borrador para tu revisión.\n\nUn abrazo,\nHéctor Ramírez\nGerente Comercial',
  'Hola Felipe:\n\nPerfecto el ajuste, lo incorporo al documento final.\n\nSaludos,\nHéctor Ramírez\nGerente Comercial'
];

let naturalScore = 0;
let app = null;
const cases = [
  {
    id: 'ST-01', name: 'Importar 12 muestras del registro colega',
    run: async () => {
      const result = await profileMod.addStyleSamples({ register: 'colega', samples: SAMPLES.map((text) => ({ text })) });
      assert(result && (result.added === 12 || result.count === 12 || result.register === 'colega'), JSON.stringify(result).slice(0, 200));
    }
  },
  {
    id: 'ST-02', name: 'Perfil calculado con firma y métricas',
    run: async () => {
      const profile = profileMod.profileForRegister(store.get(), 'colega');
      assert(profile.profile, 'sin perfil');
      assert((profile.samples || []).length >= 10, `samples=${(profile.samples || []).length}`);
      assert(String(profile.profile.signature || '').includes('Héctor'), `firma=${profile.profile.signature}`);
      assert(profile.source === 'register', `source=${profile.source}`);
    }
  },
  {
    id: 'ST-03', name: 'Score de texto natural en 0..1 con componentes',
    run: async () => {
      const profile = profileMod.profileForRegister(store.get(), 'colega').profile;
      const result = scoreText(profile, 'Hola Andrés:\n\nReviso el alcance y te confirmo mañana.\n\nUn abrazo,\nHéctor Ramírez\nGerente Comercial');
      naturalScore = result.score;
      assert(result.score >= 0 && result.score <= 1, `score=${result.score}`);
      assert(Array.isArray(result.components) || Array.isArray(result.why), 'sin componentes');
    }
  },
  {
    id: 'ST-04', name: 'Frase de IA penaliza el score',
    run: async () => {
      const profile = profileMod.profileForRegister(store.get(), 'colega').profile;
      const ai = scoreText(profile, 'En el mundo actual, es importante destacar que en la era digital debemos optimizar procesos.\n\nEn resumen, no dudes en contactarme.');
      assert(ai.score <= naturalScore, `ai=${ai.score} natural=${naturalScore}`);
      assert(ai.penalties.length > 0 || ai.why.length > 0, 'sin motivos de penalización');
    }
  },
  {
    id: 'ST-05', name: 'Compose determinista con saludo y contenido',
    run: async () => {
      const result = await composeEmail({
        register: 'colega', intent: 'Confirmar la reunión del martes y pedir el acta',
        recipient: { name: 'Andrés Molina', email: 'andres@empresa.com' }
      }, { data: store.get(), useLlm: false });
      assert(result.draft.length > 40, 'borrador vacío');
      assert(/^(Hola|Buen día|Buenos días)/.test(result.draft), result.draft.slice(0, 40));
      assert(result.draft.includes('reunión') || result.draft.includes('acta'), 'sin intención');
    }
  },
  {
    id: 'ST-06', name: 'Compose conserva la firma del perfil',
    run: async () => {
      const result = await composeEmail({
        register: 'colega', intent: 'Enviar el informe final',
        recipient: { name: 'Marta Ruiz', email: 'marta@empresa.com' }
      }, { data: store.get(), useLlm: false });
      assert(result.draft.includes('Héctor Ramírez'), result.draft.slice(-160));
      assert(result.score >= 0 && result.score <= 1, `score=${result.score}`);
    }
  },
  {
    id: 'ST-07', name: 'Registro sin muestras usa respaldo global/default',
    run: async () => {
      const fallback = profileMod.profileForRegister(store.get(), 'familiar');
      assert(fallback.profile, 'sin perfil');
      assert(['default', 'global'].includes(fallback.source), `source=${fallback.source}`);
    }
  },
  {
    id: 'ST-08', name: 'Identidad: dos correos del mismo nombre → una persona',
    run: async () => {
      app = await startTestApp();
      const contacts = await api(app.base, 'POST', '/api/identity/contacts', {
        name: 'Andrés Molina', emails: ['andres@empresa.com', 'a.molina@otro.com'], aliases: ['Andrés M.']
      });
      assert(contacts.status === 200, contacts.text.slice(0, 200));
      const resolved = await api(app.base, 'POST', '/api/identity/resolve', { email: 'a.molina@otro.com' });
      assert(resolved.status === 200, resolved.text.slice(0, 200));
      assert((resolved.json.candidates || []).length >= 1, JSON.stringify(resolved.json).slice(0, 200));
      assert(Number(resolved.json.candidates[0].confidence) > 0, 'sin confianza');
    }
  },
  {
    id: 'ST-09', name: 'Expand devuelve los dos correos de la persona',
    run: async () => {
      const expanded = await api(app.base, 'POST', '/api/identity/expand', { query: 'Andrés Molina' });
      assert(expanded.status === 200, expanded.text.slice(0, 200));
      const people = expanded.json.people || [];
      const emails = people[0]?.emails || people[0]?.recipients || [];
      assert(emails.includes('andres@empresa.com') && emails.includes('a.molina@otro.com'), JSON.stringify(emails));
    }
  },
  {
    id: 'ST-10', name: 'listPeople encuentra la persona por búsqueda',
    run: async () => {
      const listed = await api(app.base, 'GET', '/api/identity/people?q=Andr%C3%A9s');
      assert(listed.status === 200, listed.text.slice(0, 200));
      assert((listed.json.items || listed.json.people || []).length >= 1, JSON.stringify(listed.json).slice(0, 200));
      if (app) await app.close();
    }
  }
];

await runCategory('style', cases);

