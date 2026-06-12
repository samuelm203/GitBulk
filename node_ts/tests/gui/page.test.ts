/**
 * Unit-Tests für gui/page.ts (reines HTML-Rendering, kein Browser nötig).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderGuiPage, escapeHtml, type GuiPageModel } from '../../src/gui/page.js';

function model(overrides: Partial<GuiPageModel> = {}): GuiPageModel {
  return {
    rus: ['repo-a', 'repo-b'],
    dryRun: false,
    concurrency: 4,
    platform: 'github',
    ticket: 'AKB-1234',
    branch: 'feature/x',
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('escapes the five HTML special characters', () => {
    assert.equal(escapeHtml(`<a href="x" & 'y'>`), '&lt;a href=&quot;x&quot; &amp; &#39;y&#39;&gt;');
  });
});

describe('renderGuiPage', () => {
  it('contains the process mockup boxes from the flowchart image', () => {
    const html = renderGuiPage(model());
    assert.match(html, /Bitbucket Repo/);
    assert.match(html, /Anpassen/);
    assert.match(html, /PR erstellen/);
    // Loop-Pfeil (SVG) ist Teil des Mockups.
    assert.match(html, /loopArrow/);
  });

  it('renders one RU card with a mini pipeline per repository', () => {
    const html = renderGuiPage(model());
    assert.match(html, /data-ru="repo-a"/);
    assert.match(html, /data-ru="repo-b"/);
    // Mini-Pipeline-Stufen
    assert.match(html, /data-step="repo"/);
    assert.match(html, /data-step="change"/);
    assert.match(html, /data-step="pr"/);
  });

  it('shows header badges (platform, concurrency, ticket-branch) and live log panel', () => {
    const html = renderGuiPage(model());
    assert.match(html, /github/);
    assert.match(html, /concurrency 4/);
    assert.match(html, /AKB-1234-feature\/x/);
    assert.match(html, /<h2>Log<\/h2>/);
  });

  it('shows the DRY-RUN badge only in dry-run mode', () => {
    assert.match(renderGuiPage(model({ dryRun: true })), /DRY-RUN/);
    assert.doesNotMatch(renderGuiPage(model({ dryRun: false })), /badge dry/);
  });

  it('escapes hostile values (defense in depth)', () => {
    const html = renderGuiPage(model({ rus: ['<script>alert(1)</script>'], ticket: '<img onerror=x>' }));
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.doesNotMatch(html, /<img onerror=x>/);
    assert.match(html, /&lt;script&gt;/);
  });

  it('never embeds token-like environment values', () => {
    const html = renderGuiPage(model());
    assert.doesNotMatch(html, /GITBULK_.*_TOKEN/);
  });
});
