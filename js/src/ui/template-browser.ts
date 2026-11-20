/**
 * Template Browser UI — browse template categories, generate agents, and download
 */

import type { ApiClient } from '../api';
import type { GeneratedAgent, TemplateCategory } from '../types';
import { escapeHtml } from '../utils';

const FORMAT_OPTIONS = [
  { value: 'claude', label: 'Claude Code Agent', icon: '🤖', ext: '.claude/agents/' },
  { value: 'goose', label: 'Goose Recipe', icon: '🪿', ext: '.goose/recipes/' },
  { value: 'codex', label: 'Codex Agent', icon: '🔮', ext: '.codex/agents/' },
  { value: 'copilot', label: 'GitHub Copilot', icon: '✨', ext: '.github/' },
] as const;

type AgentFormat = (typeof FORMAT_OPTIONS)[number]['value'];

export class TemplateBrowser {
  private selectedCategory: string | null = null;
  private selectedAgents: Set<string> = new Set();
  private selectedFormat: AgentFormat = 'claude';
  private generatedAgents: GeneratedAgent[] = [];
  private generating = false;
  private logPrefix = '[UpworkBuddy][TemplateBrowser]';

  constructor(
    private apiClient: ApiClient,
    private container: HTMLElement,
  ) {}

  render(): Promise<void> {
    this.container.innerHTML = '';
    return this.renderCategoryList();
  }

  private async renderCategoryList(): Promise<void> {
    this.container.innerHTML = `
      <div class="upwork-buddy-template-browser">
        <h3 style="margin-top:0; color:#14a800;">🧩 Agent Templates</h3>
        <p style="color:#666; font-size:13px; margin-bottom:16px;">
          Select a framework template to generate AI agent configurations for your technology stack.
          Choose your preferred format: Claude Code agents, Goose recipes, Codex agents, or GitHub Copilot instructions.
        </p>
        <div class="upwork-buddy-template-grid" id="ub-template-grid">
          <div style="text-align:center; padding:24px; color:#999;">Loading templates...</div>
        </div>
        <div id="ub-persisted-agents" data-testid="persisted-agents-section" style="margin-top:20px;">
          <h4 style="margin:0 0 8px 0; font-size:14px; color:#333;">📦 Generated Agent Blueprints</h4>
          <div style="font-size:12px; color:#999;">Loading saved blueprints...</div>
        </div>
      </div>
    `;

    const grid = this.container.querySelector('#ub-template-grid');
    const persistedEl = this.container.querySelector('#ub-persisted-agents');
    if (!grid) return;

    const [templatesResult, agentsResult] = await Promise.allSettled([
      this.apiClient.listTemplates(),
      this.apiClient.listAgents(),
    ]);

    if (templatesResult.status === 'fulfilled') {
      const templates = templatesResult.value.templates || [];
      if (templates.length === 0) {
        grid.innerHTML =
          '<div style="text-align:center; padding:24px; color:#999;">No templates available. Make sure the backend is running.</div>';
      } else {
        grid.innerHTML = templates
          .map(
            (t) => `
          <div class="upwork-buddy-template-card" data-category="${escapeHtml(t.name)}" title="${escapeHtml(t.description)}">
            <div class="upwork-buddy-template-card-icon">${escapeHtml(t.icon)}</div>
            <div class="upwork-buddy-template-card-name">${escapeHtml(t.display_name)}</div>
            <div style="font-size:11px; color:#888; margin-top:4px;">${t.agent_count} agents</div>
          </div>
        `,
          )
          .join('');

        grid.querySelectorAll('.upwork-buddy-template-card').forEach((card) => {
          card.addEventListener('click', () => {
            const name = (card as HTMLElement).dataset.category || '';
            this.selectCategory(name);
          });
        });

        this.log('Template categories loaded', { count: templates.length });
      }
    } else {
      const msg =
        templatesResult.reason instanceof Error
          ? templatesResult.reason.message
          : String(templatesResult.reason);
      grid.innerHTML = `<div class="upwork-buddy-error">❌ Failed to load templates: ${escapeHtml(msg)}</div>`;
      console.error(this.logPrefix, 'Failed to load templates', templatesResult.reason);
    }

    if (persistedEl) {
      const persistedAgents =
        agentsResult.status === 'fulfilled' && Array.isArray(agentsResult.value?.agents)
          ? agentsResult.value.agents
          : [];
      this.renderPersistedAgentsSection(persistedEl as HTMLElement, persistedAgents);
    }
  }

  private async selectCategory(name: string): Promise<void> {
    this.selectedCategory = name;
    this.selectedAgents.clear();
    this.generatedAgents = [];

    this.container.innerHTML = `
      <div class="upwork-buddy-template-browser">
        <button class="upwork-buddy-back-btn" id="ub-back-btn">← Back to Templates</button>
        <div id="ub-category-detail">
          <div style="text-align:center; padding:24px; color:#999;">Loading template details...</div>
        </div>
      </div>
    `;

    this.container.querySelector('#ub-back-btn')?.addEventListener('click', () => {
      this.selectedCategory = null;
      this.render();
    });

    const detail = this.container.querySelector('#ub-category-detail');
    if (!detail) return;

    try {
      const category = await this.apiClient.getTemplate(name);
      this.renderCategoryDetail(category, detail as HTMLElement);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      detail.innerHTML = `<div class="upwork-buddy-error">❌ Failed to load template: ${escapeHtml(msg)}</div>`;
    }
  }

  private renderCategoryDetail(category: TemplateCategory, container: HTMLElement): void {
    const blueprintsHtml = category.agent_blueprints
      .map(
        (bp) => `
      <div class="upwork-buddy-agent-item">
        <label>
          <input type="checkbox" data-agent-name="${escapeHtml(bp.name)}" class="ub-agent-checkbox" checked />
          <span class="upwork-buddy-agent-item-title">${escapeHtml(bp.title)}</span>
          <div class="upwork-buddy-agent-item-desc">${escapeHtml(bp.description)}</div>
        </label>
      </div>
    `,
      )
      .join('');

    const formatOptionsHtml = FORMAT_OPTIONS.map(
      (opt) => `
      <option value="${opt.value}" ${opt.value === this.selectedFormat ? 'selected' : ''}>${opt.icon} ${opt.label}</option>
    `,
    ).join('');

    container.innerHTML = `
      <h3 style="margin-top:0; color:#14a800;">${escapeHtml(category.icon)} ${escapeHtml(category.display_name)}</h3>
      <p style="color:#666; font-size:13px; margin-bottom:16px;">${escapeHtml(category.description)}</p>
      ${
        category.docs.length > 0
          ? `
        <div style="margin-bottom:16px;">
          <h4 style="margin-bottom:4px; font-size:13px; color:#555;">📚 Documentation Sources</h4>
          <div style="font-size:12px; color:#888;">
            ${category.docs.map((d) => `<span style="margin-right:8px;">${escapeHtml(d.label)}</span>`).join(' · ')}
          </div>
        </div>
      `
          : ''
      }
      <div style="margin-bottom:16px;">
        <h4 style="margin-bottom:4px; font-size:13px; color:#555;">🔧 Output Format</h4>
        <select id="ub-format-select" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
          ${formatOptionsHtml}
        </select>
        <p style="font-size:11px; color:#888; margin:4px 0 0 0;">
          ${
            this.selectedFormat === 'claude'
              ? 'Generates .claude/agents/*.md files with YAML frontmatter'
              : this.selectedFormat === 'goose'
                ? 'Generates .goose/recipes/*.yaml files'
                : this.selectedFormat === 'codex'
                  ? 'Generates .codex/agents/*.md instruction files'
                  : 'Generates .github/copilot-instructions.md'
          }
        </p>
      </div>
      <h4 style="margin-bottom:8px; font-size:14px; color:#333;">Available Agents</h4>
      <div class="upwork-buddy-agent-list" id="ub-agent-list">
        ${blueprintsHtml}
      </div>
      <div class="upwork-buddy-agent-actions" id="ub-agent-actions">
        <button class="upwork-buddy-generate-btn" id="ub-generate-btn">🤖 Generate Selected Agents</button>
        <button class="upwork-buddy-download-btn" id="ub-download-btn" style="display:none;">📦 Download .zip</button>
        <span id="ub-status-text" style="font-size:13px; color:#666; margin-left:8px;"></span>
      </div>
      <div id="ub-generated-agents"></div>
    `;

    // Bind format selector
    const formatSelect = container.querySelector('#ub-format-select') as HTMLSelectElement;
    if (formatSelect) {
      formatSelect.addEventListener('change', () => {
        this.selectedFormat = formatSelect.value as AgentFormat;
        // Update the description text
        const descEl = container.querySelector('#ub-format-select + p') as HTMLElement;
        if (descEl) {
          const descriptions: Record<string, string> = {
            claude: 'Generates .claude/agents/*.md files with YAML frontmatter',
            goose: 'Generates .goose/recipes/*.yaml files',
            codex: 'Generates .codex/agents/*.md instruction files',
            copilot: 'Generates .github/copilot-instructions.md',
          };
          descEl.textContent = descriptions[this.selectedFormat] || '';
        }
      });
    }

    // Bind checkboxes
    container.querySelectorAll('.ub-agent-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => {
        this.updateSelectedAgents(container);
        this.updateGenerateButton(container);
      });
    });

    // Bind generate button
    container.querySelector('#ub-generate-btn')?.addEventListener('click', () => {
      this.handleGenerate(container);
    });

    // Bind download button
    container.querySelector('#ub-download-btn')?.addEventListener('click', () => {
      this.handleDownload();
    });

    this.updateSelectedAgents(container);
    this.log('Template detail rendered', {
      category: category.name,
      agents: category.agent_blueprints.length,
    });
  }

  private updateSelectedAgents(container: HTMLElement): void {
    this.selectedAgents.clear();
    container.querySelectorAll('.ub-agent-checkbox:checked').forEach((cb) => {
      const name = (cb as HTMLInputElement).dataset.agentName;
      if (name) this.selectedAgents.add(name);
    });
  }

  private updateGenerateButton(container: HTMLElement): void {
    const btn = container.querySelector('#ub-generate-btn') as HTMLButtonElement;
    if (btn) {
      btn.disabled = this.selectedAgents.size === 0 || this.generating;
    }
  }

  private async handleGenerate(container: HTMLElement): Promise<void> {
    if (!this.selectedCategory || this.selectedAgents.size === 0 || this.generating) return;

    this.generating = true;
    const generateBtn = container.querySelector('#ub-generate-btn') as HTMLButtonElement;
    const statusText = container.querySelector('#ub-status-text') as HTMLElement;

    if (generateBtn) generateBtn.disabled = true;
    if (statusText)
      statusText.innerHTML = '<span class="upwork-buddy-loading"></span> Generating agents...';

    try {
      const response = await this.apiClient.generateAgents({
        template_name: this.selectedCategory,
        agent_names: Array.from(this.selectedAgents),
        format: this.selectedFormat,
      });

      this.generatedAgents = response.agents || [];

      if (statusText) statusText.innerHTML = `✅ Generated ${this.generatedAgents.length} agent(s)`;

      // Show generated agent previews
      const previewContainer = container.querySelector('#ub-generated-agents');
      if (previewContainer) {
        previewContainer.innerHTML = this.generatedAgents
          .map((r) => this.renderGeneratedAgent(r))
          .join('');

        // Add toggle handlers for expand/collapse
        previewContainer.querySelectorAll('.ub-content-toggle').forEach((btn) => {
          btn.addEventListener('click', () => {
            const targetId = (btn as HTMLElement).dataset.target;
            const target = targetId
              ? previewContainer.querySelector<HTMLElement>(
                  `[id="${targetId.replace(/"/g, '\\"')}"]`,
                )
              : null;
            if (target) {
              target.style.display = target.style.display === 'none' ? 'block' : 'none';
            }
          });
        });
      }

      // Show download button
      const downloadBtn = container.querySelector('#ub-download-btn') as HTMLButtonElement;
      if (downloadBtn && this.generatedAgents.length > 0) {
        downloadBtn.style.display = 'inline-block';
      }

      this.log('Agents generated', {
        count: this.generatedAgents.length,
        format: this.selectedFormat,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (statusText) statusText.innerHTML = `❌ ${escapeHtml(msg)}`;
      console.error(this.logPrefix, 'Agent generation failed', error);
    } finally {
      this.generating = false;
      if (generateBtn) generateBtn.disabled = this.selectedAgents.size === 0;
    }
  }

  private async handleDownload(): Promise<void> {
    if (this.generatedAgents.length === 0) return;

    try {
      // Use agent names (without extension) as the download key
      const agentNames = this.generatedAgents.map((r) => r.file_name.replace(/\.(yaml|md)$/, ''));
      const blob = await this.apiClient.downloadAgents(agentNames);

      // Trigger browser download
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;

      // Name the zip based on format
      const zipName =
        this.selectedFormat === 'goose'
          ? 'goose-recipes.zip'
          : this.selectedFormat === 'claude'
            ? 'claude-agents.zip'
            : this.selectedFormat === 'codex'
              ? 'codex-agents.zip'
              : 'copilot-instructions.zip';
      a.download = zipName;

      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.log('Agents downloaded as zip');
    } catch (error) {
      console.error(this.logPrefix, 'Download failed', error);
    }
  }

  private renderPersistedAgentsSection(container: HTMLElement, agents: GeneratedAgent[]): void {
    if (agents.length === 0) {
      container.innerHTML = `
        <h4 style="margin:0 0 8px 0; font-size:14px; color:#333;">📦 Generated Agent Blueprints</h4>
        <div style="font-size:12px; color:#888;">No generated agent blueprints saved yet.</div>
      `;
      return;
    }

    const cardsHtml = agents
      .map((agent, idx) => {
        const displayName = agent.blueprint_name || agent.file_name;
        const contentId = `ub-persisted-content-${idx}`;
        const formatLabel =
          FORMAT_OPTIONS.find((f) => f.value === agent.format)?.label || agent.format;
        return `
          <div style="margin: 8px 0; border: 1px solid #e0e0e0; border-radius: 6px; overflow: hidden;" data-testid="persisted-agent-item">
            <div style="padding: 8px 12px; background: #f8f8f8; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
              <div>
                <strong style="color:#333; font-size:13px;">📄 ${escapeHtml(displayName)}</strong>
                <span style="font-size:11px; color:#666; margin-left:6px;">${escapeHtml(agent.template_name)}</span>
                <span style="font-size:11px; color:#888; margin-left:6px;">${escapeHtml(formatLabel)}</span>
              </div>
              <div style="display:flex; gap:8px; align-items:center;">
                <button type="button" class="ub-persisted-toggle" data-target="${contentId}" style="background:none; border:none; color:#14a800; cursor:pointer; font-size:12px;">
                  ▼ Preview
                </button>
                <button type="button" class="ub-persisted-download-btn" data-index="${idx}" style="background:#14a800; color:#fff; border:none; border-radius:4px; padding:3px 8px; cursor:pointer; font-size:11px;">
                  📦 Download .zip
                </button>
              </div>
            </div>
            <div id="${contentId}" class="upwork-buddy-agent-preview" style="display:none; white-space:pre-wrap; font-family:monospace; font-size:12px; padding:8px 12px; background:#fafafa; max-height:300px; overflow:auto;">${escapeHtml(agent.content)}</div>
          </div>
        `;
      })
      .join('');

    container.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
        <h4 style="margin:0; font-size:14px; color:#333;">📦 Generated Agent Blueprints (${agents.length})</h4>
        <button type="button" id="ub-persisted-download-all-btn" class="upwork-buddy-download-btn" style="font-size:12px; padding:4px 10px;">
          📦 Download All (.zip)
        </button>
      </div>
      ${cardsHtml}
    `;

    container.querySelectorAll('.ub-persisted-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetId = (btn as HTMLElement).dataset.target;
        const target = targetId
          ? container.querySelector<HTMLElement>(`[id="${targetId.replace(/"/g, '\\"')}"]`)
          : null;
        if (target) {
          target.style.display = target.style.display === 'none' ? 'block' : 'none';
        }
      });
    });

    container.querySelectorAll('.ub-persisted-download-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number((btn as HTMLElement).dataset.index);
        const agent = agents[idx];
        if (!agent) return;
        const agentName = agent.blueprint_name || agent.file_name.replace(/\.(yaml|md)$/, '');
        void this.downloadAgentsZip([agentName], `${agentName}.zip`, {
          template_name: agent.template_name,
          format: agent.format,
        });
      });
    });

    container.querySelector('#ub-persisted-download-all-btn')?.addEventListener('click', () => {
      const names = agents.map((a) => a.blueprint_name || a.file_name.replace(/\.(yaml|md)$/, ''));
      void this.downloadAgentsZip(names, 'generated-agents.zip');
    });
  }

  private async downloadAgentsZip(
    agentNames: string[],
    zipName: string,
    options?: { template_name?: string; format?: string },
  ): Promise<void> {
    if (agentNames.length === 0) return;
    try {
      const blob = await this.apiClient.downloadAgents(agentNames, options);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.log('Agents downloaded as zip', { count: agentNames.length });
    } catch (error) {
      console.error(this.logPrefix, 'Download failed', error);
    }
  }

  private renderGeneratedAgent(agent: GeneratedAgent): string {
    const contentId = `ub-content-${escapeHtml(agent.file_name).replace(/[^a-zA-Z0-9]/g, '_')}`;
    const truncatedContent =
      agent.content.length > 500
        ? `${agent.content.substring(0, 500)}\n... (click to expand)`
        : agent.content;
    const fullContent = agent.content;

    const formatLabel = FORMAT_OPTIONS.find((f) => f.value === agent.format)?.label || agent.format;

    return `
      <div style="margin: 12px 0; border: 1px solid #e0e0e0; border-radius: 6px; overflow: hidden;">
        <div style="padding: 8px 12px; background: #f8f8f8; display: flex; align-items: center; justify-content: space-between;">
          <div>
            <strong style="color:#333; font-size:13px;">📄 ${escapeHtml(agent.file_name)}</strong>
            <span style="font-size:11px; color:#888; margin-left:8px;">${escapeHtml(formatLabel)}</span>
          </div>
          <button class="ub-content-toggle" data-target="${contentId}" style="background:none; border:none; color:#14a800; cursor:pointer; font-size:12px;">
            ▼ Expand
          </button>
        </div>
        <div id="${contentId}" class="upwork-buddy-agent-preview" style="display:none; white-space:pre-wrap; font-family:monospace; font-size:12px; padding:8px 12px; background:#fafafa; max-height:400px; overflow:auto;">${escapeHtml(fullContent)}</div>
        <div class="upwork-buddy-agent-preview" style="max-height:80px; overflow:hidden; opacity:0.7; white-space:pre-wrap; font-family:monospace; font-size:11px; padding:4px 12px;">${escapeHtml(truncatedContent)}</div>
      </div>
    `;
  }

  private log(message: string, payload?: Record<string, unknown>): void {
    if (payload) {
      console.log(this.logPrefix, message, payload);
    } else {
      console.log(this.logPrefix, message);
    }
  }
}
