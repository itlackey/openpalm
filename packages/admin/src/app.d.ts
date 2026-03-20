declare module "$stack/core.compose.yml?raw" {
  const content: string;
  export default content;
}
declare module "$stack/automations/cleanup-logs.yml?raw" {
  const content: string;
  export default content;
}
declare module "$stack/automations/cleanup-data.yml?raw" {
  const content: string;
  export default content;
}

declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
