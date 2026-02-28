declare module "$assets/docker-compose.yml?raw" {
  const content: string;
  export default content;
}
declare module "$assets/Caddyfile?raw" {
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
