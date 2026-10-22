import { Config, Context, type Redacted } from "effect"

export interface SandboxdSettings {
  readonly token: Redacted.Redacted<string>
  readonly workspaceDir: string
  readonly port: number
}

export class SandboxdConfig extends Context.Tag("sandboxd/SandboxdConfig")<
  SandboxdConfig,
  SandboxdSettings
>() {}

/** `SANDBOXD_TOKEN` has no default: the daemon refuses to start without it. */
export const settingsFromEnv = Config.all({
  token: Config.redacted(Config.nonEmptyString("SANDBOXD_TOKEN")),
  workspaceDir: Config.string("WORKSPACE_DIR").pipe(Config.withDefault("/workspace")),
  port: Config.integer("PORT").pipe(Config.withDefault(7070))
})
