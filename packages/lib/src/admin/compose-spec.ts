export type ComposeSpec = {
  version?: string;
  services: Record<string, ComposeService>;
  networks?: Record<string, Record<string, unknown>>;
};

export type ComposeService = {
  image: string;
  restart?: string;
  env_file?: string[];
  environment?: string[] | Record<string, string>;
  ports?: string[];
  volumes?: string[];
  networks?: string[];
  depends_on?: Record<string, { condition: string }> | string[];
  command?: string;
  healthcheck?: ComposeHealthcheck;
  user?: string;
  working_dir?: string;
};

export type ComposeHealthcheck = {
  test: string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  start_period?: string;
};
