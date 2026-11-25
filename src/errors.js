// Errors whose message is written by this code and safe to show the client. Any other error (a parser error
// quoting a response body, a bug, a dependency) gets a generic message instead.
export class PublicError extends Error {}
