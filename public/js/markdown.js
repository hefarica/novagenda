/**
 * Render de markdown ligero y SEGURO para mensajes del asistente.
 * - Escapa todo el HTML de entrada (nunca se inyecta texto del usuario).
 * - Soporta: párrafos, saltos de línea, **negrita**, *cursiva*, `código`,
 *   bloques ```, listas con viñetas y numeradas, títulos #, citas > y enlaces http(s).
 * - No soporta HTML crudo, imágenes ni tablas (a propósito).
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[\s(])_([^_\n][^\n]*?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return out;
}

export function renderMessage(value) {
  let text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';

  // 1) Bloques de código: se extraen antes de procesar líneas.
  const fences = [];
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    fences.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000FENCE${fences.length - 1}\u0000`;
  });

  // 2) Líneas: párrafos, listas, títulos, citas y saltos.
  const lines = text.split('\n');
  const html = [];
  let list = null; // 'ul' | 'ol'
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`</${list}>`);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    const fenceRef = line.trim().match(/^\u0000FENCE(\d+)\u0000$/);
    if (fenceRef) {
      flushParagraph();
      flushList();
      html.push(fences[Number(fenceRef[1])] || '');
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      html.push(`<h4>${inline(heading[1])}</h4>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      if (list !== 'ul') { flushList(); html.push('<ul>'); list = 'ul'; }
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    const ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (list !== 'ol') { flushList(); html.push('<ol>'); list = 'ol'; }
      html.push(`<li>${inline(ordered[2])}</li>`);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      html.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    flushList();
    paragraph.push(inline(line));
  }

  flushParagraph();
  flushList();

  return `<div class="md">${html.join('')}</div>`;
}
