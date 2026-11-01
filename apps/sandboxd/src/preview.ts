/** Fill `{port}` and `{session}` in the configured preview URL template. */
export const renderPreviewUrl = (
  template: string,
  values: { readonly port: number; readonly session: string }
): string =>
  template.replaceAll("{port}", String(values.port)).replaceAll("{session}", values.session)
