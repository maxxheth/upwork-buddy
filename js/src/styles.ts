/**
 * CSS styles for Upwork Buddy UI
 */

export const STYLES = `
.upwork-buddy-button-container {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 999999;
  display: none;
  flex-direction: row;
  gap: 12px;
  padding: 16px;
  background: white;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  border: 1px solid #e0e0e0;
}

.upwork-buddy-button-container.visible {
  display: flex;
}

.upwork-buddy-trigger {
  background: #14a800;
  color: white;
  border: none;
  padding: 12px 20px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  display: flex;
  align-items: center;
  gap: 8px;
  transition: all 0.2s ease;
}

.upwork-buddy-trigger:hover {
  background: #0e7a00;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  transform: translateY(-1px);
}

.upwork-buddy-view-projects-btn {
  background: #108ee9;
  color: white;
  border: none;
  padding: 12px 20px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  align-items: center;
  gap: 8px;
  transition: all 0.2s ease;
}

.upwork-buddy-view-projects-btn.visible {
  display: flex;
}

.upwork-buddy-view-projects-btn:hover {
  background: #0c6cb3;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  transform: translateY(-1px);
}

.upwork-buddy-profile-btn {
  background: #f0ad4e;
  color: white;
  border: none;
  padding: 12px 20px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  display: flex;
  align-items: center;
  gap: 8px;
  transition: all 0.2s ease;
}

.upwork-buddy-profile-btn:hover {
  background: #ec971f;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  transform: translateY(-1px);
}

.upwork-buddy-view-projects-btn .badge {
  background: rgba(255, 255, 255, 0.3);
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 12px;
}

.upwork-buddy-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 1000000;
  display: none;
}

.upwork-buddy-modal-overlay.active {
  display: flex;
  align-items: center;
  justify-content: center;
}

.upwork-buddy-modal {
  background: white;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  width: 90%;
  max-width: 800px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  position: relative;
}

.upwork-buddy-modal-header {
  background: #14a800;
  color: white;
  padding: 16px 20px;
  border-radius: 12px 12px 0 0;
  cursor: move;
  display: flex;
  justify-content: space-between;
  align-items: center;
  user-select: none;
}

.upwork-buddy-modal-title {
  font-weight: 600;
  font-size: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.upwork-buddy-modal-controls {
  display: flex;
  gap: 8px;
}

.upwork-buddy-modal-btn {
  background: rgba(255, 255, 255, 0.2);
  border: none;
  color: white;
  width: 28px;
  height: 28px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
}

.upwork-buddy-modal-btn:hover {
  background: rgba(255, 255, 255, 0.3);
}

.upwork-buddy-modal-body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.upwork-buddy-section {
  margin-bottom: 12px;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  overflow: hidden;
}

.upwork-buddy-section-header {
  background: #f5f5f5;
  padding: 12px 16px;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  user-select: none;
  transition: background 0.2s;
}

.upwork-buddy-section-header:hover {
  background: #ebebeb;
}

.upwork-buddy-section-header h4 {
  color: #14a800;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.upwork-buddy-section-toggle {
  color: #666;
  font-size: 18px;
  transition: transform 0.3s;
}

.upwork-buddy-section-toggle.open {
  transform: rotate(180deg);
}

.upwork-buddy-section-content {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease;
}

.upwork-buddy-section-content.open {
  max-height: 5000px;
  overflow-y: auto;
}

.upwork-buddy-section-body {
  padding: 16px;
  max-height: 400px;
  overflow-y: auto;
}

.upwork-buddy-section .upwork-buddy-section {
  margin-bottom: 8px;
  border-color: #e8e8e8;
}

.upwork-buddy-section .upwork-buddy-section .upwork-buddy-section-header {
  background: #fafafa;
  padding: 10px 14px;
}

.upwork-buddy-section .upwork-buddy-section .upwork-buddy-section-header:hover {
  background: #f0f0f0;
}

.upwork-buddy-section .upwork-buddy-section .upwork-buddy-section-header h4 {
  font-size: 14px;
}

.upwork-buddy-section .upwork-buddy-section .upwork-buddy-section-body {
  padding: 12px;
  max-height: 300px;
}

.upwork-buddy-section-body::-webkit-scrollbar,
.upwork-buddy-section-content.open::-webkit-scrollbar {
  width: 8px;
}

.upwork-buddy-section-body::-webkit-scrollbar-track,
.upwork-buddy-section-content.open::-webkit-scrollbar-track {
  background: #f1f1f1;
  border-radius: 4px;
}

.upwork-buddy-section-body::-webkit-scrollbar-thumb,
.upwork-buddy-section-content.open::-webkit-scrollbar-thumb {
  background: #c1c1c1;
  border-radius: 4px;
}

.upwork-buddy-section-body::-webkit-scrollbar-thumb:hover,
.upwork-buddy-section-content.open::-webkit-scrollbar-thumb:hover {
  background: #a1a1a1;
}

.upwork-buddy-section p {
  font-size: 14px;
  line-height: 1.6;
  color: #333;
  margin: 0 0 12px 0;
  white-space: pre-wrap;
}

.upwork-buddy-section p:last-child {
  margin-bottom: 0;
}

.upwork-buddy-section ul {
  margin: 0;
  padding-left: 20px;
}

.upwork-buddy-section li {
  font-size: 14px;
  line-height: 1.6;
  color: #333;
  margin-bottom: 8px;
}

.upwork-buddy-section li:last-child {
  margin-bottom: 0;
}

.upwork-buddy-loading {
  text-align: center;
  padding: 40px;
  color: #666;
}

.upwork-buddy-error {
  background: #fee;
  color: #c00;
  padding: 16px;
  border-radius: 8px;
  font-size: 14px;
}

.upwork-buddy-config-actions {
  display: flex;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}

.upwork-buddy-save-profile-btn {
  background: #108ee9;
  color: white;
  border: none;
  padding: 10px 18px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
}

.upwork-buddy-save-profile-btn:hover {
  background: #0c6cb3;
}

.upwork-buddy-profile-status {
  font-size: 13px;
  margin-top: 12px;
  min-height: 18px;
}

.upwork-buddy-portfolio-item {
  margin-bottom: 12px;
  padding: 14px;
  border: 1px dashed #d1d1d1;
  border-radius: 8px;
  background: #fafafa;
}

.upwork-buddy-portfolio-item label {
  font-size: 12px;
  font-weight: 600;
  display: block;
  margin-bottom: 4px;
  color: #444;
}

.upwork-buddy-portfolio-input {
  width: 100%;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 10px;
  font-size: 13px;
  box-sizing: border-box;
}

.upwork-buddy-portfolio-description {
  min-height: 60px;
}

.upwork-buddy-remove-portfolio-item {
  background: transparent;
  color: #c82333;
  border: none;
  padding: 6px 12px;
  cursor: pointer;
  font-weight: 600;
}

.upwork-buddy-add-portfolio-item-btn {
  background: #108ee9;
  color: white;
  border: none;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}

.upwork-buddy-add-portfolio-item-btn:hover {
  background: #0c6cb3;
}

.upwork-buddy-portfolio-hint {
  color: #666;
  font-size: 13px;
  margin: 0;
  padding: 12px 0;
}

.upwork-buddy-projects-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.upwork-buddy-project-item {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.upwork-buddy-project-item:hover {
  border-color: #14a800;
  box-shadow: 0 2px 8px rgba(20, 168, 0, 0.1);
}

.upwork-buddy-project-title {
  font-weight: 600;
  color: #14a800;
  margin: 0 0 8px 0;
  font-size: 15px;
}

.upwork-buddy-project-meta {
  font-size: 13px;
  color: #666;
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.upwork-buddy-project-timestamp {
  color: #999;
  font-size: 12px;
}

.upwork-buddy-cached-badge {
  display: inline-block;
  background: #fff3cd;
  color: #856404;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  margin-left: 8px;
}

.upwork-buddy-clear-cache-btn {
  background: #dc3545;
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  margin-top: 12px;
  width: 100%;
}

.upwork-buddy-clear-cache-btn:hover {
  background: #c82333;
}

.upwork-buddy-cache-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 16px;
}

.upwork-buddy-secondary-btn {
  background: #f5f5f5;
  color: #333;
  border: 1px solid #e0e0e0;
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
}

.upwork-buddy-secondary-btn:hover {
  background: #ebebeb;
}

.upwork-buddy-health-warning {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 999998;
  background: #fff3cd;
  color: #856404;
  padding: 10px 16px;
  font-size: 13px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  border-bottom: 2px solid #ffc107;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.upwork-buddy-health-warning span {
  flex: 1;
  text-align: center;
}

.upwork-buddy-health-dismiss {
  background: transparent;
  border: 1px solid #856404;
  color: #856404;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
  transition: background 0.2s;
}

.upwork-buddy-health-dismiss:hover {
  background: #856404;
  color: white;
}

.upwork-buddy-job-history {
  margin-top: 8px;
}

.upwork-buddy-job-history h3 {
  margin-top: 0;
  color: #14a800;
  font-size: 16px;
}

.upwork-buddy-job-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.upwork-buddy-job-card {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 14px 16px;
  background: #fff;
  transition: all 0.2s ease;
}

.upwork-buddy-job-card:hover {
  border-color: #14a800;
  box-shadow: 0 2px 8px rgba(20, 168, 0, 0.1);
}

.upwork-buddy-job-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 8px;
}

.upwork-buddy-job-card-header h4 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: #333;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upwork-buddy-job-card-time {
  font-size: 12px;
  color: #999;
  white-space: nowrap;
  flex-shrink: 0;
}

.upwork-buddy-job-card-details {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 13px;
  color: #666;
  margin-bottom: 10px;
}

.upwork-buddy-job-card-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.upwork-buddy-view-job {
  background: #108ee9;
  color: white;
  border: none;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
  transition: background 0.2s ease;
}

.upwork-buddy-view-job:hover {
  background: #0c6cb3;
}

.upwork-buddy-delete-job {
  background: transparent;
  color: #dc3545;
  border: 1px solid #dc3545;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s ease;
}

.upwork-buddy-delete-job:hover {
  background: #dc3545;
  color: white;
}

.upwork-buddy-empty-state {
  text-align: center;
  padding: 40px 20px;
  color: #999;
}

.upwork-buddy-empty-state p:first-child {
  font-size: 16px;
  margin-bottom: 8px;
}

.upwork-buddy-job-history-btn {
  background: #6f42c1;
  color: white;
  border: none;
  padding: 12px 20px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  display: flex;
  align-items: center;
  gap: 8px;
  transition: all 0.2s ease;
}

.upwork-buddy-job-history-btn:hover {
  background: #5a32a3;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  transform: translateY(-1px);
}

@media (max-width: 600px) {
  .upwork-buddy-job-card-header {
    flex-direction: column;
    gap: 4px;
  }

  .upwork-buddy-job-card-details {
    flex-direction: column;
    gap: 4px;
  }

  .upwork-buddy-job-card-actions {
    justify-content: stretch;
  }

  .upwork-buddy-view-job,
  .upwork-buddy-delete-job {
    flex: 1;
    text-align: center;
  }

  /* ── Template Browser ──────────────────────────────────────── */
  .upwork-buddy-template-browser { max-width: 700px; margin: 0 auto; }
  .upwork-buddy-template-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; margin: 16px 0; }
  .upwork-buddy-template-card { background: #fff; border: 2px solid #e0e0e0; border-radius: 10px; padding: 16px; cursor: pointer; text-align: center; transition: all 0.2s; }
  .upwork-buddy-template-card:hover { border-color: #14a800; transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
  .upwork-buddy-template-card.active { border-color: #14a800; background: #f0faf0; }
  .upwork-buddy-template-card-icon { font-size: 32px; margin-bottom: 8px; }
  .upwork-buddy-template-card-name { font-weight: 600; color: #333; font-size: 13px; }
  .upwork-buddy-agent-list { margin: 12px 0; }
  .upwork-buddy-agent-item { display: flex; align-items: flex-start; gap: 8px; padding: 8px 0; border-bottom: 1px solid #f0f0f0; }
  .upwork-buddy-agent-item:last-child { border-bottom: none; }
  .upwork-buddy-agent-item input[type="checkbox"] { margin-top: 3px; accent-color: #14a800; }
  .upwork-buddy-agent-item-title { font-weight: 500; color: #333; }
  .upwork-buddy-agent-item-desc { color: #666; font-size: 12px; margin-top: 2px; }
  .upwork-buddy-generate-btn, .upwork-buddy-download-btn { background: #14a800; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; margin-right: 8px; transition: background 0.2s; }
  .upwork-buddy-generate-btn:hover, .upwork-buddy-download-btn:hover { background: #0f8c00; }
  .upwork-buddy-generate-btn:disabled, .upwork-buddy-download-btn:disabled { background: #999; cursor: not-allowed; }
  .upwork-buddy-agent-preview { background: #1e1e1e; color: #d4d4d4; padding: 12px; border-radius: 6px; font-family: 'Courier New', monospace; font-size: 11px; white-space: pre-wrap; overflow-x: auto; max-height: 300px; overflow-y: auto; margin: 8px 0; }
  .upwork-buddy-agent-actions { display: flex; gap: 8px; margin: 12px 0; align-items: center; }
  .upwork-buddy-loading { display: inline-block; width: 16px; height: 16px; border: 2px solid #fff; border-top-color: transparent; border-radius: 50%; animation: upwork-buddy-spin 0.6s linear infinite; vertical-align: middle; margin-right: 6px; }
  @keyframes upwork-buddy-spin { to { transform: rotate(360deg); } }
  .upwork-buddy-back-btn { background: #666; color: white; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; margin-bottom: 12px; }
  .upwork-buddy-back-btn:hover { background: #555; }
}
`;

export function injectStyles(): void {
  if (!document.getElementById('upwork-buddy-styles')) {
    const styleTag = document.createElement('style');
    styleTag.id = 'upwork-buddy-styles';
    styleTag.textContent = STYLES;
    document.head.appendChild(styleTag);
  }
}
