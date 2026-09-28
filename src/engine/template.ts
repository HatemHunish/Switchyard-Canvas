/**
 * Minimal {{path.to.value}} templating for prompts. Objects are rendered as
 * pretty JSON; unknown paths render as an empty string.
 */
export function renderTemplate(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, path: string) => {
    const value = path.split('.').reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), ctx);
    if (value == null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  });
}
