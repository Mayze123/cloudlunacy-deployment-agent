# Nixpacks Build Plan Templates

This directory contains templates for Nixpacks build plans that are used to build application containers without Dockerfiles.

## Default Plans

The `default-plans.json` file contains predefined build plans for various application types. These plans are used as a fallback when no custom plans are defined.

## Custom Plans

To create custom build plans, you can:

1. Create a `nixpacks-plans.json` file in the `config` directory of the CloudLunacy agent
2. Set the `NIXPACKS_CONFIG_DIR` environment variable to point to a custom directory containing a `plans.json` file

## Format

Each plan is defined as a JSON object with the following structure:

```json
{
  "appType": {
    "name": "Human readable name",
    "providers": ["provider1", "provider2"],
    "phases": {
      "setup": {
        "cmds": ["cmd1", "cmd2"]
      },
      "build": {
        "cmds": ["build-cmd1", "build-cmd2"]
      },
      "install": {
        "cmds": ["install-cmd1"]
      }
    },
    "variables": {
      "ENV_VAR1": "value1",
      "ENV_VAR2": "value2"
    },
    "start": "command to start the application"
  }
}
```

Where:

- `appType` is the key used to look up the plan (e.g., 'node', 'react', 'python')
- `name` is a human-readable name for the plan
- `providers` is an array of Nixpacks providers to use
- `phases` defines commands for different build phases
- `variables` defines environment variables to set
- `start` is the command to run to start the application

## Example: Custom Node.js Plan

```json
{
  "node": {
    "name": "Custom Node.js Configuration",
    "providers": ["node"],
    "phases": {
      "setup": {
        "cmds": ["npm ci --omit=dev"]
      },
      "build": {
        "cmds": ["npm run build:prod"]
      }
    },
    "start": "node dist/server.js"
  }
}
```

For more information on Nixpacks build plans, see the [Nixpacks documentation](https://nixpacks.com/docs/configuration/plans).
