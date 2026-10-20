export const turboRpc = {
  id: "opencode-turbo",
  methods: {},
  events: {
    toast: {
      description: "Show an opencode-turbo recovery notification",
      schema: {
        type: "object",
        required: ["sessionID", "location", "title", "message", "variant", "duration"],
        properties: {
          sessionID: { type: "string" },
          location: { type: "object", required: ["directory"], properties: { directory: { type: "string" }, workspaceID: { type: "string" } } },
          title: { type: "string" }, message: { type: "string" },
          variant: { type: "string", enum: ["info", "success", "warning", "error"] }, duration: { type: "number" },
        },
      },
    },
  },
} as const
