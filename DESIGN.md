---
name: Tokiwa
description: The design system of the Tokiwa terminal app.
colors:
  bg: "terminal default"
  surface: "#0a0a0a"
  selected: "#16312a"
  hover: "#0e1f1a"
  fg: "#e3e4e8"
  muted: "#a4a7b1"
  line: "#292929"
  track: "#454850"
  edge: "#3d6e60"
  cpu: "#74c9ad"
  ram: "#9991f3"
  warning: "#d6ad6e"
  critical: "#f2aa9a"
---

# Design System: Tokiwa

## Overview

**Creative North Star: A quiet place to find a terminal and resume work.**

Preserve the diamond wordmark, dark ground, muted context and keyboard controls. These rules apply to the app in `app/`.

**The plain-text Health view is the design language for every view.** A view is native terminal text: bold section titles flush left, rows indented two cells with aligned label and value columns, and dim lines for context. No view uses icons, emoji or images. Colour marks state and keys; it never carries meaning alone where a word or a marker can carry it.

## Colors and typography

Mint identifies CPU, active navigation, keys in the shortcuts sheet, the output glyph `◆`, the session in the pane (its bar and name) and Health bars in the normal state; violet identifies memory. The needs-you glyph `◈` and the disconnected glyph `○` are amber (`warning`); the quiet glyph `◇`, the exited glyph `·`, the client count and the state words are dim. Recent output does not imply success. A Health bar and its figure turn amber at 80 % and soft orange (`critical`) at 95 %.

The terminal controls native text size. Bold marks section titles, group titles, the wordmark and the selected row. Muted text carries context: group details, keys and dim hints in the footer, and the header host state. Actions in the sheet, the search and the footer controls use the normal text colour, so a control reads apart from a hint that does nothing. The quick keys in the search are mint, like the keys of the sheet.

## Layout

The root uses two columns of horizontal padding (one below 70 columns), a two-row header with the host state at its right, a navigation row and a two-row footer with one line of controls for the context. Inside a terminal a control is its label then its chord, dim (`copy ctrl+shift+c`); elsewhere its key then its label (`enter attach`). Hints join with ` · `. When the line is too long, the hints that are not controls go first, then the key labels, then the least important controls; `shortcuts` stays. Over a session row the footer explains that row's state instead: the glyph in its colour, then dim plain words (`◈ needs you · coder-lead rang the bell while no client viewed it`), a short form when it is narrow.

**Session list.** The list is a tree of projects. A project such as `shop/api` lists under `shop`, and each level indents two cells. Projects and sessions sort by name, and the order of the top-level projects can be changed by a drag. A project title is bold; a project labelled with a directory shows the last two parts of the directory. A shell opened with Shell here lists under its source after `└`. A blank line parts the top-level projects, and `+ new project` follows the last one. A row is a two-cell bar column, one status glyph and a space, the name column, then two spaces and a dim word. The glyphs are `◆` output, `◇` quiet, `◈` needs you, `○` disconnected (this app's transport ended) and `·` exited; without an observation the glyph cell is empty. The word appears only for states that need an action: `needs you`, `disconnected` and `exited` (and `attaching` while the app attaches). The count of clients attached elsewhere follows the name as one superscript digit (`¹` to `⁹`, then `⁹⁺`), and nothing for zero. Names give way first. The session in the pane has `▎` in the bar column and an accent name. The selected row has the `selected` band and a `›` marker, which takes the place of the bar. The top bar carries no session status. A row under the pointer has the `hover` band, the selection band at about 60 % weight, with no marker. At 100 columns and wider, the list is 28 % of the width (36 to 44 cells) beside the terminal pane; below that, with `--layout terminal` or in focus mode, the list and the terminal each take the full width in turn.

**Focus mode.** `z`, or **Focus** in the search, hides the list beside the terminal. While the terminal is in view, the navigation row shows the other sessions after Health in one line: output and needs-you sessions by glyph and name, the rest counted by state (`◆ web-lead · ◈ coder-lead · 4 quiet`), parts joined with ` · `. When the line is too long, the counts join as `N more`, and then the output names join them; needs-you names stay. An error takes the place of the strip.

**Empty pane.** Until a session is attached, the right pane shows a bold title and two dim lines: how to attach, and `t opens a local shell · ? shortcuts`.

**Shortcuts sheet.** The sheet replaces the body. A bold title, then four columns of groups (Workspace, Session, Terminal, Health with Files) when they fit, else two, else one. Keys align within a group, in mint; actions follow in the text colour. Below the groups, the legend of the status glyphs (`◆ output  ◇ quiet  ◈ needs you  ○ disconnected  · exited  ¹ other clients`): each glyph in its state colour, the labels dim, wrapped at the two-space gaps when it is wider than the sheet. A dim last line names the search key. When the height is short, the blank lines go first; then the sheet scrolls.

**Search.** A 56-cell panel on the `surface` colour, full width below 70 columns, over a cleared view down to the footer. An input row after a mint `›`, then, until the first keystroke, the quick keys in the footer style (`d detach · z focus · w sessions · ? shortcuts`). An empty input lists a few common actions under category titles (Session, Go to, Terminal, Tokiwa), at most three each; a title is dim and a rule in the `track` colour fills the rest of its row, and its items indent two more cells. Typed text lists the matching sessions and actions, sessions first, with titles only when more than one category matches, else under a rule. A result row is the name, and at its right the project of a session or the key of an action, dim. No icons or bracketed hints.

**Health.** A centered column capped at 116 cells. A bold section title sits flush left; its rows indent two cells, with a 16-cell label column. Bars start in the value column, are at most 50 cells wide and give way first when the width shrinks; labels never shorten. In Spend, the bar measures spend so far against the budget, under the `Spent so far:` row; the Forecast row is a number with its share of the budget, amber from 95 % of the budget and soft orange above it. A bar is a heavy line for the filled part with a half-cell end piece, on a thin track line in the `track` colour, so adjacent bars stay separate. Blank lines separate sections only when the whole view fits; otherwise the blank row above the view goes, then the blank lines, and then the view scrolls.

## Elevation and shapes

Flat surfaces establish depth without shadows. Only the search panel is raised, by the `surface` colour; selection is a band, and the pointer highlight a fainter band of the same hue. Panels remain rectangular. The diamond remains native text.

## Motion

One element moves: the output glyph `◆` throbs. Its shape stays; its colour steps from mint toward the `track` colour and back in four 320 ms frames. The glyph updates in place, so the list is not drawn again and a text selection in it stays. With `TOKIWA_REDUCED_MOTION=1` the glyph is still, in mint.

## Components

Each terminal view owns a PTY and terminal screen. Switching views retains that state. The search and the sheet remove terminal focus; closing them restores it. A click in the sidebar outside a row gives the keyboard to the list; a click on a terminal pane gives it back. A click on a footer control keeps the keyboard and the selection where they are. Resize reaches the child PTY. A focused terminal receives every key except Ctrl+K and Ctrl+Shift+C.

A recorded reading (`--snapshot FILE`) is labelled as recorded, and the app adds no readings to it.

## Rules

- Show missing data as `not available` with its reason, never as zero.
- Keep the data source visible: the header names the EC2 host state.
- Do not infer agent intent from terminal output. `needs you` reports the tmux bell flag of the session; it does not say what the program wants.
- Do not take a key from a focused terminal for a new action.
