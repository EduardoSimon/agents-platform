import { Schema } from "effect"

export class PathOutsideWorkspace extends Schema.TaggedError<PathOutsideWorkspace>()(
  "PathOutsideWorkspace",
  {
    path: Schema.String
  }
) {}

export class PathNotFound extends Schema.TaggedError<PathNotFound>()("PathNotFound", {
  path: Schema.String
}) {}

export class EditNotFound extends Schema.TaggedError<EditNotFound>()("EditNotFound", {
  path: Schema.String
}) {}

export class EditAmbiguous extends Schema.TaggedError<EditAmbiguous>()("EditAmbiguous", {
  path: Schema.String,
  occurrences: Schema.Int
}) {}

export class ProcessNotFound extends Schema.TaggedError<ProcessNotFound>()("ProcessNotFound", {
  name: Schema.String
}) {}

export class ProcessAlreadyRunning extends Schema.TaggedError<ProcessAlreadyRunning>()(
  "ProcessAlreadyRunning",
  { name: Schema.String }
) {}

/** Any other I/O or spawn failure; the message is safe to show to the caller. */
export class ToolIoError extends Schema.TaggedError<ToolIoError>()("ToolIoError", {
  message: Schema.String
}) {}

export const ToolError = Schema.Union(
  PathOutsideWorkspace,
  PathNotFound,
  EditNotFound,
  EditAmbiguous,
  ProcessNotFound,
  ProcessAlreadyRunning,
  ToolIoError
)
export type ToolError = typeof ToolError.Type

export const statusOf = (error: ToolError): number => {
  switch (error._tag) {
    case "PathOutsideWorkspace":
      return 403
    case "PathNotFound":
    case "ProcessNotFound":
      return 404
    case "EditNotFound":
    case "EditAmbiguous":
    case "ProcessAlreadyRunning":
      return 409
    case "ToolIoError":
      return 500
  }
}
