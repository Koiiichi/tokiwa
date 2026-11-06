# Product

<!-- impeccable:product-schema 1 -->

## Platform

Terminal UI. The Impeccable platform enum does not describe this platform.
Do not interpret this project as a web application.

## Users

A developer who keeps long-running Claude Code, Codex and shell sessions on a cloud Linux host and works on them from a Mac terminal.

## Product Purpose

Keep terminal sessions running on the host, and make them quick to find, attach, watch and end from the Mac.
Keep native terminal behaviour: a program in a session receives every key except the app's own.
Keep direct commands (`tokiwa attach NAME`, `tokiwa new NAME`) available beside the app.

## Operating Context

The Mac reaches the host through AWS Session Manager. The host runs one tmux server in a sandboxed systemd service.
Claude Code, Codex and Docker run inside the sessions on the host.

## Capabilities and Constraints

The app lists the sessions in a tree of projects, attaches them in embedded terminal views, and opens local shells.
It reads the session snapshot every 30 seconds while the workspace is in view.
Health samples the host every 30 seconds while the app is open and keeps at most 120 readings in memory.
Health does not change workloads or service limits.
Status glyphs compare hashes of pane screens. They report observed output, a quiet screen, a bell, a dropped transport or ended panes.
They do not infer agent intent, stalls or success.
Ending a session asks in its row and checks the session identity, so an old selection cannot end a replacement with the same name.
Ending a session closes its terminals. Detached background processes can remain.
The app does not launch models or control agent workflows.
Activity history and conversation search are outside the product.

## Brand Commitments

Keep the dark, quiet terminal look and the session-first layout.
Keep the diamond wordmark.
Use terminal-native rendering and keyboard controls.

## Product Principles

Show observed state.
Keep direct commands available.
Use established session management.
Do not create another orchestration service.
