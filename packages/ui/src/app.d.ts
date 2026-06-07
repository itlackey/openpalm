declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      /** Admin auth role resolved from the `op_session` cookie by hooks.server.ts. */
      role: 'admin' | null;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
