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
  display: none;
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
`;

export function injectStyles(): void {
  if (!document.getElementById('upwork-buddy-styles')) {
    const styleTag = document.createElement('style');
    styleTag.id = 'upwork-buddy-styles';
    styleTag.textContent = STYLES;
    document.head.appendChild(styleTag);
  }
}
