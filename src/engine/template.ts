/**
 * Minimal {{path.to.value}} templating for prompts. Objects are rendered as
 * pretty JSON; unknown paths render as an empty string. `wrap` can mark up
 * individual values (e.g. fence untrusted content) by their path.
 */
export function renderTemplate(template: string, ctx: Record<string, unknown>, wrap?: (path: string, text: string) => string): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, path: string) => {
    const value = path.split('.').reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), ctx);
    if (value == null) return '';
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return wrap ? wrap(path, text) : text;
  });
}
