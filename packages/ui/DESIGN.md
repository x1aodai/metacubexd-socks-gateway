# MetaCubeXD SOCKS Gateway design system

## Direction

The interface is a focused operations console: light, quiet and direct. It
should feel approachable to a first-time operator while keeping port, route and
health information easy to compare. Decoration never competes with state.

The running components and [`assets/css/main.css`](./assets/css/main.css) are
the implementation source of truth. Update this document with visible behavior
changes; do not invent unused tokens here.

## Foundation

- Use the single daisyUI `light` theme.
- Use white and light slate surfaces, dark slate text and amber for identity,
  focus and primary emphasis.
- Use green for confirmed success, red for failure/destructive action and amber
  for warning or unknown state. Pair every color with text or an icon.
- Body typography uses the system CJK stack from `main.css`; do not download Web
  fonts.
- Port numbers, stable identifiers, versions and one-time secrets use a
  monospace face and tabular numerals where alignment matters.
- Global `:focus-visible` uses a two-pixel primary outline with offset.

## Layout

Wide screens use a fixed left navigation and a scrollable content region.
Narrow screens use a compact header and bottom navigation. Both contain exactly
four destinations: `端口`、`节点`、`账号`、`系统`, plus logout.

Pages use a centered `max-w-7xl` content column, compact horizontal padding and
larger vertical spacing on wide screens. A page starts with:

1. one plain-language title;
2. one short sentence describing the operator job;
3. at most the actions needed for that page.

Use grids for comparable resources and let cards stack naturally at narrow
widths. Do not hide core actions behind hover-only controls.

## Surfaces and hierarchy

- Canvas: `base-100` or the equivalent light slate background.
- Navigation and secondary strips: `base-200` with a subtle border.
- Resource card: white, one-pixel slate border, modest radius and only a small
  shadow when separation is needed.
- Inline editor: a tinted secondary section directly below its owning resource.
- Alert: bordered tinted surface with a clear `role="alert"` or `role="status"`.

Avoid nested cards. Use a border or spacing before adding another container.

## Components

### Buttons

- Dark slate is the default high-emphasis action.
- Amber marks the page's primary create action.
- White bordered buttons are secondary actions.
- Red tinted buttons are destructive and require impact confirmation where
  data relationships can change.
- Disabled buttons remain readable and explain busy state through nearby text.

Button text names the operation (`保存端口`, `同步`, `轮换密码`), not a vague
confirmation such as `确定` unless the dialog already states the exact action.

### Forms

- Labels remain visible above or beside controls; placeholders do not replace
  labels.
- Keep credential binding and Hop configuration next to the affected resource.
- Validation appears before mutation when possible and stays close to the
  invalid field.
- Use native selection, checkbox and dialog behavior unless the product needs a
  capability the platform does not provide.

### Status

`StatusBadge` owns the shared health vocabulary: healthy, unhealthy, unknown
and disabled. A badge always includes readable text. Show configured route and
active runtime route as separate fields; do not imply they are identical.

Mutation success and a later refresh failure are separate outcomes. Preserve
the success message and append the refresh problem instead of presenting the
mutation as failed.

### Dialogs

- Use the shared native `Modal` pattern.
- State the affected Nodes, Credentials or Port Slots before destructive work.
- Keep the confirm action disabled while the mutation is running.
- One-time password dialogs clear the secret from component state when closed.

## Page-specific rules

### Ports

- Always render ten rows in numeric order.
- Lead with slot and fixed port, then health, account/Hop summary, active route
  and edit action.
- Keep one-hop/two-hop and manual/auto/failover choices explicit.
- Poll read-only status at five-second intervals, prevent overlapping requests
  and clear the timer when the page unmounts.

### Nodes

- Show display name, source, referenced ports, protocol and health.
- Import uses preview then apply.
- Batch deletion gathers impact first and reports each result in stable order.
- Testing or disabling a Node does not imply an automatic Hop-count change.

### Credentials

- Show username, enabled state and bound ports; never show a stored password.
- Creation and rotation display a password once in the dedicated secret dialog.
- Deletion states the ports that lose the Credential.

### System

- Present Web, Agent and Mihomo state without exposing the Controller address or
  secret.
- Show listener and apply status in operator language.
- Keep reapply, subscription refresh and administrator password change distinct.

## Interaction and accessibility

- Prevent double submission with one in-flight mutation per resource or page.
- Keep read polling from overwriting an editor or an in-flight save.
- Move focus into dialogs and return it to the invoking control on close.
- Give icon-only controls an `aria-label`; decorative icons are hidden from
  assistive technology.
- Use `aria-current="page"` for navigation and live regions for action results.
- Preserve visible focus, logical source order and touch targets at narrow
  widths.
- Respect reduced motion. State changes should not depend on animation.

## Do not add

- additional navigation destinations without approved product scope;
- multiple themes or remote font dependencies;
- raw internal error text or secret-bearing diagnostics;
- ornamental charts that do not help operate a Port Slot;
- automatic route or Hop-count changes hidden from the operator.
