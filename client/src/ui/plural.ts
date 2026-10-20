// English singular/plural selection. Callers may still pass the historical
// three-form tuple; the second form is used for every non-singular count.
export function plural(count: number, forms: [string, string, string]): string {
  return Math.abs(count) === 1 ? forms[0] : forms[1] || forms[2]
}

export function pluralWithCount(count: number, forms: [string, string, string]): string {
  return `${count} ${plural(count, forms)}`
}

export const OBJECTS: [string, string, string] = ['object', 'objects', 'objects']

export const BOARDS: [string, string, string] = ['board', 'boards', 'boards']
