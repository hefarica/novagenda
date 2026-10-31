/** Categoría E: lingo (10 casos). */
import { prepare, runCategory, assert, equal } from './harness.mjs';

prepare('golden-lingo-');
const { store } = await import(new URL('../../lib/store.mjs', import.meta.url));
const storeMod = await import(new URL('../../lib/lingo/store.mjs', import.meta.url));
const engine = await import(new URL('../../lib/lingo/engine.mjs', import.meta.url));

const data = () => store.get();
let term = null;
let learned = null;

const cases = [
  {
    id: 'LG-01', name: 'Crear término shadow con variantes',
    run: async () => {
      const result = storeMod.createOrUpdateTerm(data(), {
        term: 'Héctor Fabio Riascos C.',
        variants: ['hector fabio riascos', 'Héctor F. Riascos'],
        context: 'cliente'
      }, { actor: 'golden' });
      term = result.item;
      equal(term.status, 'shadow', 'status');
      assert(term.variants.length >= 2, 'variantes');
    }
  },
  {
    id: 'LG-02', name: 'Listar términos incluye el creado',
    run: async () => {
      const listed = storeMod.listTerms(data(), { limit: 50 });
      assert(listed.items.some((item) => item.id === term.id), 'no listado');
    }
  },
  {
    id: 'LG-03', name: 'Shadow no se aplica por defecto',
    run: async () => {
      const applied = engine.applyCanonical('Reunión con hector fabio riascos mañana', { data: data() });
      assert(String(applied.text).includes('hector fabio riascos'), applied.text);
      equal(applied.changed, false, 'changed');
    }
  },
  {
    id: 'LG-04', name: 'Aprobar término y aplicar forma canónica',
    run: async () => {
      storeMod.setTermStatus(data(), term.id, 'approved', { actor: 'golden' });
      const applied = engine.applyCanonical('Reunión con hector fabio riascos mañana', { data: data() });
      assert(String(applied.text).includes('Héctor Fabio Riascos C.'), applied.text);
      equal(applied.changed, true, 'changed');
    }
  },
  {
    id: 'LG-05', name: 'Hotwords solo approved y con presupuesto',
    run: async () => {
      const result = engine.hotwords('Héctor Riascos cliente', 30, { data: data() });
      assert(Array.isArray(result.terms) || Array.isArray(result.items), JSON.stringify(result).slice(0, 200));
      const terms = result.terms || result.items;
      assert(terms.length >= 1, 'sin hotwords');
      assert(Number(result.chars || 0) <= 30, `chars=${result.chars}`);
    }
  },
  {
    id: 'LG-06', name: 'Learn 1 corrección deja shadow sin promover',
    run: async () => {
      const learnedOnce = engine.learn({ original: 'predio rosario', corrected: 'Predio El Rosario', source: 'golden' }, { data: data() });
      learned = learnedOnce.item;
      equal(learnedOnce.promoted, false, 'promoted');
      equal(learned.status, 'shadow', 'status');
      equal(learned.corrections, 1, 'corrections');
    }
  },
  {
    id: 'LG-07', name: 'Learn 3 correcciones promueve a approved',
    run: async () => {
      engine.learn({ original: 'predio rosario', corrected: 'Predio El Rosario', source: 'golden' }, { data: data() });
      const third = engine.learn({ original: 'predio rosario', corrected: 'Predio El Rosario', source: 'golden' }, { data: data() });
      equal(third.promoted, true, 'promoted');
      equal(third.item.status, 'approved', 'status');
    }
  },
  {
    id: 'LG-08', name: 'Suggest detecta el término aprobado con confianza',
    run: async () => {
      const suggestions = engine.suggest('Visita al Predio El Rosario con Héctor Fabio Riascos C.', { data: data(), limit: 10 });
      assert(Array.isArray(suggestions) && suggestions.length >= 1, JSON.stringify(suggestions).slice(0, 200));
      assert(suggestions.some((item) => Number(item.confidence) > 0), 'sin confianza');
    }
  },
  {
    id: 'LG-09', name: 'Conflicto de variantes entre términos → LINGO_CONFLICT',
    run: async () => {
      try {
        storeMod.createOrUpdateTerm(data(), { term: 'Lote Doce', variants: ['predio rosario'] }, { actor: 'golden' });
        throw new Error('no lanzó conflicto');
      } catch (error) {
        equal(error.code, 'LINGO_CONFLICT', `code=${error.code}`);
      }
    }
  },
  {
    id: 'LG-10', name: 'Término rechazado deja de aplicarse',
    run: async () => {
      storeMod.setTermStatus(data(), term.id, 'rejected', { actor: 'golden', reason: 'golden reject' });
      const applied = engine.applyCanonical('Reunión con hector fabio riascos mañana', { data: data() });
      equal(applied.changed, false, 'changed');
      assert(String(applied.text).includes('hector fabio riascos'), applied.text);
    }
  }
];

await runCategory('lingo', cases);
