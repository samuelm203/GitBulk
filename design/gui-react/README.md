# GitBulk — GUI Design-Prototyp (React + Tailwind)

Ein **eigenständiger** Design-Prototyp des GitBulk-Run-Dashboards in
React + TypeScript + Tailwind CSS + Lucide.

> **Wichtig:** Dieser Ordner ist bewusst **vom CLI getrennt**. Er hat eine
> eigene `package.json` und einen eigenen Vite-Build und fügt dem
> ausgelieferten Tool (`node_ts/`) **keine Abhängigkeiten** hinzu. Die echte,
> produktive GUI bleibt die build-freie, dependency-arme Variante in
> `node_ts/src/gui/`. Dieser Prototyp dient als Design-Referenz und
> Präsentations-Artefakt.

## Starten

```bash
cd design/gui-react
npm install
npm run dev          # http://localhost:5173
```

Weitere Skripte:

```bash
npm run typecheck    # tsc --noEmit (strict, exactOptionalPropertyTypes)
npm run build        # Typecheck + Vite-Produktionsbuild nach dist/
npm run preview      # gebautes dist/ lokal ausliefern
```

`?autostart` an die URL hängen, um den simulierten Lauf direkt abzuspielen
(praktisch für Screenshots/Demos).

## Designsystem

- **Farbe** — neutrale `zinc`-Skala + genau **ein** Markenakzent (CSS-Blau
  `#00A4E0`, als `brand`-Token in `src/index.css`). Zustandsfarben nur, wo sie
  Bedeutung tragen: emerald = neu, brand = aktualisiert, amber = übersprungen,
  red = fehlgeschlagen. Keine Verläufe, ein Hairline-Border, keine Deko-Schatten.
- **Abstände** — 4px-Basis, 8-pt-Rhythmus. Weißraum trennt, nicht Boxen.
- **Typografie** — System-UI; drei Größen (13px Daten, 11.5px Großbuchstaben-
  Labels, 17px Wortmarke); `tabular-nums` für Zahlen/Dauern.
- **Hierarchie** — ein primäres Signal (Lauf-Status), ruhige Abschnitts-Labels,
  die Daten sind das Lauteste.

## Architektur

```
src/
  types.ts                 Domänentypen + StreamEvent-Union (= SSE-Events)
  lib/format.ts            Dauer-/Uhr-Formatierung
  lib/simulation.ts        simulierter Lauf-Stream (Worker-Pool, Concurrency)
  hooks/useRunStream.ts    Reducer: Event-Strom → UI-Zustand (quellenneutral)
  components/
    AppHeader · StatusDot · Badge
    ProcessFlow · StatCluster
    RepoTable · MiniPipeline
    LogPanel · SummaryBanner
  App.tsx · main.tsx
```

## An ein echtes Backend anschließen

Die `StreamEvent`-Union in `types.ts` ist **deckungsgleich** mit den SSE-Events
des GitBulk-Servers (`started` · `log` · `progress` · `summary`,
siehe `node_ts/src/gui/server.ts`). Für den Produktivbetrieb ersetzt man in
`useRunStream` lediglich die `simulateRun(...)`-Quelle durch:

```ts
const es = new EventSource('/events');
es.addEventListener('progress', (e) => dispatch({ type: 'event', event: { kind: 'progress', ...JSON.parse(e.data) } }));
es.addEventListener('log',      (e) => dispatch({ type: 'event', event: { kind: 'log', ...JSON.parse(e.data) } }));
es.addEventListener('summary',  (e) => dispatch({ type: 'event', event: { kind: 'summary', ...JSON.parse(e.data) } }));
es.addEventListener('started',  ()  => dispatch({ type: 'event', event: { kind: 'started' } }));
```

Der Reducer und alle Komponenten bleiben unverändert.
