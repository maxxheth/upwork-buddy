/**
 * Upwork Buddy - Job Analysis Bookmarklet
 * 
 * This script extracts Upwork job postings from the page and sends them
 * to the Upwork Buddy API for AI analysis.
 * 
 * Usage:
 * 1. Save as bookmarklet or run in console
 * 2. Click on Upwork job listings page
 * 3. Expandable panels will appear on each job card
 */

(function() {
    'use strict';
    
    const API_BASE_URL = 'http://localhost:9090';
    const USER_PROFILE = 'Experienced full-stack developer with 10+ years in web development, specializing in Go, React, and PostgreSQL. Strong background in building scalable APIs and database-driven applications.';
    const USER_SKILLS = 'Go, JavaScript, TypeScript, React, Node.js, PostgreSQL, MySQL, Docker, Git, RESTful APIs, GraphQL, AWS, CI/CD';
    
    // Cache for analyzed jobs (memoization)
    const analyzedJobs = new Map(); // key: job title, value: { jobInfo, analysis, timestamp }
    
    // Styles for the modal and trigger button
    const styles = `
        .upwork-buddy-trigger {
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: #14a800;
            color: white;
            border: none;
            padding: 12px 20px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            font-size: 14px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            z-index: 999999;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .upwork-buddy-trigger:hover {
            background: #0e7a00;
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
        }
        
        .upwork-buddy-view-projects-btn {
            position: fixed;
            bottom: 20px;
            right: 160px;
            background: #108ee9;
            color: white;
            border: none;
            padding: 12px 20px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            font-size: 14px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            z-index: 999999;
            display: none;
            align-items: center;
            gap: 8px;
        }
        
        .upwork-buddy-view-projects-btn:hover {
            background: #0c6cb3;
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
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
        
        .upwork-buddy-modal.minimized {
            max-height: auto;
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
        
        .upwork-buddy-modal.minimized .upwork-buddy-modal-body {
            display: none;
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
        
        /* Nested sections styling */
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
        
        /* Custom scrollbar for better UX */
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
        
        .upwork-buddy-analyze-btn {
            background: #14a800;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            font-size: 14px;
            width: 100%;
        }
        
        .upwork-buddy-analyze-btn:hover {
            background: #0e7a00;
        }
        
        .upwork-buddy-analyze-btn:disabled {
            background: #ccc;
            cursor: not-allowed;
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
    
    // Inject styles
    function injectStyles() {
        if (!document.getElementById('upwork-buddy-styles')) {
            const styleTag = document.createElement('style');
            styleTag.id = 'upwork-buddy-styles';
            styleTag.textContent = styles;
            document.head.appendChild(styleTag);
        }
    }
    
    // Extract job information from a job card
    function extractJobInfo(container) {
        console.log('🔍 Extracting from container:', container.className);
        
        // Try multiple selectors for title
        const titleSelectors = [
            'h2[itemprop="name"]',
            'h2.h4',
            'h3.job-tile-title a', 
            '[data-test="job-title-link"]', 
            'h2 a', 
            '.job-tile-title a',
            'h2',
            'h3'
        ];
        
        let titleEl = null;
        for (const selector of titleSelectors) {
            titleEl = container.querySelector(selector);
            if (titleEl && titleEl.textContent.trim()) {
                console.log('✅ Found title with selector:', selector);
                break;
            }
        }
        
        // Try multiple selectors for description
        const descSelectors = [
            '[data-test="Description"]',
            '[data-test="job-description-text"]',
            '[data-test="job-description-line-clamp"] span',
            '.job-description',
            '.description',
            '[data-test="UpCLineClamp"] span'
        ];
        
        let descEl = null;
        for (const selector of descSelectors) {
            descEl = container.querySelector(selector);
            if (descEl && descEl.textContent.trim()) {
                console.log('✅ Found description with selector:', selector);
                break;
            }
        }
        
        // Try multiple selectors for budget
        const budgetSelectors = [
            '[data-test="is-fixed-price"]',
            '[data-test="budget"]',
            '.budget',
            '[data-test="job-type-label"]'
        ];
        
        let budgetEl = null;
        for (const selector of budgetSelectors) {
            budgetEl = container.querySelector(selector);
            if (budgetEl && budgetEl.textContent.trim()) {
                console.log('✅ Found budget with selector:', selector);
                break;
            }
        }
        
        // Skills are in anchor tags with class air3-token or similar
        const skillsEls = container.querySelectorAll('a.air3-token, [data-test="token"], .skill-badge, .o-tag-skill, [data-test="attr-item"]');
        console.log(`✅ Found ${skillsEls.length} skill elements`);
        
        const jobInfo = {
            title: titleEl ? titleEl.textContent.trim() : 'Unknown Title',
            description: descEl ? descEl.textContent.trim() : 'No description available',
            budget: budgetEl ? budgetEl.textContent.trim() : 'Not specified',
            skills: Array.from(skillsEls).map(el => el.textContent.trim()).join(', ') || 'Not specified'
        };
        
        return jobInfo;
    }
    
    // Call the API to analyze the job
    async function analyzeJob(jobInfo, useCache = false) {
        // Create a more robust cache key using title + first 100 chars of description
        const cacheKey = `${jobInfo.title}||${jobInfo.description.substring(0, 100)}`;
        
        // Only use cache if explicitly requested (for View Projects feature)
        if (useCache && analyzedJobs.has(cacheKey)) {
            console.log('📦 Using cached analysis for:', jobInfo.title);
            return { ...analyzedJobs.get(cacheKey).analysis, _cached: true };
        }
        
        // Always make fresh API call for "Analyze Job" button (stateless)
        console.log('🌐 Fetching fresh analysis for:', jobInfo.title);
        console.log('🔑 Cache key:', cacheKey.substring(0, 80) + '...');
        console.log('📊 Current cache size:', analyzedJobs.size);
        
        const response = await fetch(`${API_BASE_URL}/api/analyze-job`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                job_title: jobInfo.title,
                job_description: jobInfo.description,
                budget: jobInfo.budget,
                skills: jobInfo.skills,
                user_profile: USER_PROFILE,
                user_skills: USER_SKILLS
            })
        });
        
        if (!response.ok) {
            throw new Error(`API error: ${response.status} ${response.statusText}`);
        }
        
        const analysis = await response.json();
        
        // Cache the result for later viewing in projects list
        analyzedJobs.set(cacheKey, {
            jobInfo,
            analysis,
            timestamp: new Date().toISOString(),
            cacheKey // Store for reference
        });
        
        console.log('✅ Cached analysis. New cache size:', analyzedJobs.size);
        console.log('📋 Cache keys:', Array.from(analyzedJobs.keys()).map(k => k.substring(0, 50) + '...'));
        
        // Update the View Projects button badge
        updateProjectsBadge();
        
        return analysis;
    }
    
    // Escape HTML to prevent injection and parsing errors
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // Render a value (handles objects, arrays, strings, etc.)
    function renderValue(value, depth = 0) {
        if (value === null || value === undefined) {
            return '<em style="color: #999;">null</em>';
        }
        
        if (typeof value === 'boolean') {
            return `<strong>${value}</strong>`;
        }
        
        if (typeof value === 'number') {
            return `<strong>${value}</strong>`;
        }
        
        if (typeof value === 'string') {
            // Check if it's a JSON string
            try {
                const parsed = JSON.parse(value);
                return renderValue(parsed, depth);
            } catch (e) {
                // Escape HTML and preserve line breaks
                const escaped = escapeHtml(value);
                return `<p>${escaped.replace(/\n/g, '<br>')}</p>`;
            }
        }
        
        if (Array.isArray(value)) {
            if (value.length === 0) return '<em style="color: #999;">Empty array</em>';
            return `<ul>${value.map(item => `<li>${renderValue(item, depth + 1)}</li>`).join('')}</ul>`;
        }
        
        if (typeof value === 'object') {
            let html = '';
            Object.entries(value).forEach(([key, val]) => {
                const displayKey = escapeHtml(key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()));
                html += `
                    <div class="upwork-buddy-section" style="margin-left: ${depth * 10}px;">
                        <div class="upwork-buddy-section-header" onclick="this.parentElement.querySelector('.upwork-buddy-section-content').classList.toggle('open'); this.querySelector('.upwork-buddy-section-toggle').classList.toggle('open');">
                            <h4 style="font-size: ${15 - depth}px;">${displayKey}</h4>
                            <span class="upwork-buddy-section-toggle">▼</span>
                        </div>
                        <div class="upwork-buddy-section-content">
                            <div class="upwork-buddy-section-body">
                                ${renderValue(val, depth + 1)}
                            </div>
                        </div>
                    </div>
                `;
            });
            return html;
        }
        
        return escapeHtml(String(value));
    }
    
    // Render the analysis results
    function renderAnalysis(analysis, showCachedIndicator = false) {
        console.log('🎨 Rendering analysis with keys:', Object.keys(analysis));
        
        let html = '';
        
        // Show cached indicator if applicable (only for View Projects)
        if (showCachedIndicator && analysis._cached) {
            html += `<div style="background: #fff3cd; color: #856404; padding: 12px; border-radius: 8px; margin-bottom: 16px; font-size: 13px;">
                📦 Loaded from cache (no API call made)
            </div>`;
        }
        
        // Icons for each section
        const icons = {
            'proposal': '📝',
            'spec_sheet_prompt': '📋',
            'time_estimate': '⏱️',
            'workload_division': '🤖',
            'questions_for_client': '❓',
            'tips_and_advice': '💡',
            'tone_analysis': '🎯'
        };
        
        // Default open sections
        const defaultOpen = ['proposal', 'time_estimate'];
        
        // Render each top-level field (skip internal fields)
        Object.entries(analysis).forEach(([key, value]) => {
            if (key.startsWith('_')) return; // Skip internal fields like _cached
            
            console.log(`📄 Rendering section: ${key}`);
            
            const displayName = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            const icon = icons[key] || '📄';
            const isOpen = defaultOpen.includes(key);
            
            try {
                const renderedContent = renderValue(value, 0);
                html += `
                    <div class="upwork-buddy-section">
                        <div class="upwork-buddy-section-header" onclick="this.parentElement.querySelector('.upwork-buddy-section-content').classList.toggle('open'); this.querySelector('.upwork-buddy-section-toggle').classList.toggle('open');">
                            <h4>${icon} ${escapeHtml(displayName)}</h4>
                            <span class="upwork-buddy-section-toggle ${isOpen ? 'open' : ''}">▼</span>
                        </div>
                        <div class="upwork-buddy-section-content ${isOpen ? 'open' : ''}">
                            <div class="upwork-buddy-section-body">
                                ${renderedContent}
                            </div>
                        </div>
                    </div>
                `;
            } catch (error) {
                console.error(`❌ Error rendering section ${key}:`, error);
                html += `
                    <div class="upwork-buddy-section">
                        <div class="upwork-buddy-section-header">
                            <h4>${icon} ${escapeHtml(displayName)} (Error)</h4>
                        </div>
                        <div class="upwork-buddy-section-content open">
                            <div class="upwork-buddy-section-body">
                                <p style="color: red;">Error rendering this section: ${escapeHtml(error.message)}</p>
                            </div>
                        </div>
                    </div>
                `;
            }
        });
        
        return html;
    }
    
    // Create the modal
    function createModal() {
        const overlay = document.createElement('div');
        overlay.className = 'upwork-buddy-modal-overlay';
        overlay.id = 'upwork-buddy-modal-overlay';
        
        const modal = document.createElement('div');
        modal.className = 'upwork-buddy-modal';
        modal.id = 'upwork-buddy-modal';
        
        const header = document.createElement('div');
        header.className = 'upwork-buddy-modal-header';
        header.innerHTML = `
            <div class="upwork-buddy-modal-title">
                <span>🤖</span>
                <span>AI Proposal Assistant</span>
            </div>
            <div class="upwork-buddy-modal-controls">
                <button class="upwork-buddy-modal-btn" id="upwork-buddy-minimize" title="Minimize">−</button>
                <button class="upwork-buddy-modal-btn" id="upwork-buddy-close" title="Close">×</button>
            </div>
        `;
        
        const body = document.createElement('div');
        body.className = 'upwork-buddy-modal-body';
        body.id = 'upwork-buddy-modal-body';
        body.innerHTML = '<button class="upwork-buddy-analyze-btn">Analyze This Job</button>';
        
        modal.appendChild(header);
        modal.appendChild(body);
        overlay.appendChild(modal);
        
        // Add event listeners
        document.getElementById('upwork-buddy-close')?.addEventListener('click', () => {
            overlay.classList.remove('active');
        });
        
        document.getElementById('upwork-buddy-minimize')?.addEventListener('click', () => {
            modal.classList.toggle('minimized');
            const btn = document.getElementById('upwork-buddy-minimize');
            btn.textContent = modal.classList.contains('minimized') ? '+' : '−';
        });
        
        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.classList.remove('active');
            }
        });
        
        // Make draggable
        makeDraggable(modal, header);
        
        return overlay;
    }
    
    // Make modal draggable
    function makeDraggable(modal, handle) {
        let isDragging = false;
        let currentX, currentY, initialX, initialY;
        
        handle.addEventListener('mousedown', (e) => {
            if (e.target.closest('.upwork-buddy-modal-btn')) return;
            isDragging = true;
            initialX = e.clientX - (modal.offsetLeft || 0);
            initialY = e.clientY - (modal.offsetTop || 0);
        });
        
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
            modal.style.position = 'fixed';
            modal.style.left = currentX + 'px';
            modal.style.top = currentY + 'px';
            modal.style.transform = 'none';
        });
        
        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
    }
    
    // Create trigger button
    function createTriggerButton() {
        const button = document.createElement('button');
        button.className = 'upwork-buddy-trigger';
        button.id = 'upwork-buddy-trigger';
        button.innerHTML = '<span>🤖</span><span>Analyze Job</span>';
        button.style.display = 'none'; // Hidden by default
        
        button.addEventListener('click', () => {
            const overlay = document.getElementById('upwork-buddy-modal-overlay');
            if (overlay) {
                // Reset modal state before opening
                resetModal();
                
                overlay.classList.add('active');
                const modal = document.getElementById('upwork-buddy-modal');
                // Reset position when opening
                modal.style.position = 'relative';
                modal.style.left = '';
                modal.style.top = '';
                modal.style.transform = '';
                modal.classList.remove('minimized');
                
                // Reset minimize button
                const minimizeBtn = document.getElementById('upwork-buddy-minimize');
                if (minimizeBtn) minimizeBtn.textContent = '−';
            }
        });
        
        return button;
    }
    
    // Create View Projects button
    function createViewProjectsButton() {
        const button = document.createElement('button');
        button.className = 'upwork-buddy-view-projects-btn';
        button.id = 'upwork-buddy-view-projects-btn';
        button.innerHTML = '<span>📋</span><span>View Projects</span><span class="badge">0</span>';
        
        button.addEventListener('click', () => {
            showProjectsList();
        });
        
        return button;
    }
    
    // Update the projects badge count
    function updateProjectsBadge() {
        const btn = document.getElementById('upwork-buddy-view-projects-btn');
        if (btn) {
            const badge = btn.querySelector('.badge');
            badge.textContent = analyzedJobs.size;
            
            // Show button if we have analyzed jobs
            if (analyzedJobs.size > 0) {
                btn.style.display = 'flex';
            }
        }
    }
    
    // Show the projects list modal
    function showProjectsList() {
        const overlay = document.getElementById('upwork-buddy-modal-overlay');
        const modalBody = document.getElementById('upwork-buddy-modal-body');
        
        if (!overlay || !modalBody) return;
        
        let html = '<h3 style="margin-top: 0; color: #14a800;">📋 Analyzed Projects</h3>';
        
        console.log('📋 Showing projects list. Cache size:', analyzedJobs.size);
        
        if (analyzedJobs.size === 0) {
            html += '<p style="text-align: center; color: #999; padding: 40px;">No projects analyzed yet. Click "Analyze Job" on a job posting to get started.</p>';
        } else {
            html += '<ul class="upwork-buddy-projects-list">';
            
            // Sort by timestamp (newest first)
            const sortedJobs = Array.from(analyzedJobs.entries())
                .sort((a, b) => new Date(b[1].timestamp) - new Date(a[1].timestamp));
            
            sortedJobs.forEach(([cacheKey, data]) => {
                const { jobInfo, timestamp } = data;
                const date = new Date(timestamp);
                const timeAgo = getTimeAgo(date);
                
                // Escape quotes in cache key for onclick handler
                const escapedKey = cacheKey.replace(/'/g, "\\'").replace(/"/g, '\\"');
                
                html += `
                    <li class="upwork-buddy-project-item" onclick="window.upworkBuddyShowProject(\`${escapedKey}\`)">
                        <h4 class="upwork-buddy-project-title">${jobInfo.title}</h4>
                        <div class="upwork-buddy-project-meta">
                            <span>💰 ${jobInfo.budget}</span>
                            <span>🔧 ${jobInfo.skills.split(',').slice(0, 3).join(',')}</span>
                        </div>
                        <div class="upwork-buddy-project-timestamp">Analyzed ${timeAgo}</div>
                    </li>
                `;
            });
            
            html += '</ul>';
            html += '<button class="upwork-buddy-clear-cache-btn" onclick="window.upworkBuddyClearCache()">🗑️ Clear All Cached Projects</button>';
        }
        
        modalBody.innerHTML = html;
        overlay.classList.add('active');
    }
    
    // Show a specific project's analysis
    window.upworkBuddyShowProject = function(cacheKey) {
        console.log('🔍 Looking up project with cache key:', cacheKey.substring(0, 50) + '...');
        const data = analyzedJobs.get(cacheKey);
        if (!data) {
            console.error('❌ Project not found in cache');
            return;
        }
        
        const modalBody = document.getElementById('upwork-buddy-modal-body');
        const analysis = { ...data.analysis, _cached: true };
        
        modalBody.innerHTML = `
            <button onclick="window.upworkBuddyBackToList()" style="background: #108ee9; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; margin-bottom: 16px;">
                ← Back to Projects List
            </button>
            <h3 style="margin-top: 0; color: #14a800;">${data.jobInfo.title}</h3>
            ${renderAnalysis(analysis, true)}
        `;
    };
    
    // Go back to projects list
    window.upworkBuddyBackToList = function() {
        showProjectsList();
    };
    
    // Clear cache
    window.upworkBuddyClearCache = function() {
        if (confirm('Are you sure you want to clear all cached project analyses?')) {
            analyzedJobs.clear();
            updateProjectsBadge();
            showProjectsList();
        }
    };
    
    // Format time ago
    function getTimeAgo(date) {
        const seconds = Math.floor((new Date() - date) / 1000);
        
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
        if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;
        
        return date.toLocaleDateString();
    }
    
    // Watch for the job details drawer to open
    function watchForDrawer() {
        console.log('👀 Watching for job details drawer...');
        
        // Use MutationObserver to detect when drawer appears
        const observer = new MutationObserver((mutations) => {
            // Look for the job details content drawer
            const drawer = document.querySelector('.job-details-content');
            
            if (drawer && !drawer.hasAttribute('data-upwork-buddy')) {
                console.log('✅ Job details drawer found!');
                showAnalyzeButton(drawer);
            }
        });
        
        // Start observing the document body for changes
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
        
        console.log('✅ Drawer observer activated');
    }
    
    // Show the analyze button when drawer opens
    function showAnalyzeButton(drawer) {
        const trigger = document.getElementById('upwork-buddy-trigger');
        if (trigger) {
            trigger.style.display = 'flex';
            // Mark that we've shown the button for this drawer
            drawer.setAttribute('data-upwork-buddy', 'true');
        }
    }
    
    // Reset modal to initial state
    function resetModal() {
        const modalBody = document.getElementById('upwork-buddy-modal-body');
        modalBody.innerHTML = '<button class="upwork-buddy-analyze-btn">Analyze This Job</button>';
        
        // Re-attach the click handler
        const analyzeBtn = modalBody.querySelector('.upwork-buddy-analyze-btn');
        analyzeBtn.addEventListener('click', handleAnalyze);
    }
    
    // Handle the analyze button click
    async function handleAnalyze() {
        // Use the entire drawer as the context for extraction
        const drawer = document.querySelector('.job-details-content');
        
        if (!drawer) {
            alert('Could not find job details drawer');
            return;
        }
        
        const analyzeBtn = document.querySelector('.upwork-buddy-analyze-btn');
        analyzeBtn.disabled = true;
        analyzeBtn.textContent = 'Analyzing...';
        
        const modalBody = document.getElementById('upwork-buddy-modal-body');
        modalBody.innerHTML = '<div class="upwork-buddy-loading">🤖 Analyzing job posting with AI...</div>';
        
        try {
            // Extract directly from drawer (it contains the currently open job)
            const jobInfo = extractJobInfo(drawer);
            console.log('📊 Extracting job info from current drawer:', jobInfo);
            console.log('📝 Title:', jobInfo.title);
            console.log('📄 Description length:', jobInfo.description.length);
            console.log('💰 Budget:', jobInfo.budget);
            console.log('🔧 Skills:', jobInfo.skills);
            
            // Always make fresh API call (useCache = false for stateless behavior)
            const analysis = await analyzeJob(jobInfo, false);
            console.log('✅ Got analysis response:', analysis);
            console.log('📋 Analysis keys:', Object.keys(analysis));
            console.log('📏 Analysis structure:', JSON.stringify(analysis, null, 2).substring(0, 500) + '...');
            
            // Don't show cached indicator for fresh analyses
            modalBody.innerHTML = renderAnalysis(analysis, false);
        } catch (error) {
            console.error('❌ Analysis error:', error);
            console.error('Error stack:', error.stack);
            modalBody.innerHTML = `
                <div class="upwork-buddy-error">
                    ❌ Error: ${escapeHtml(error.message)}
                    <br><br>
                    Make sure the Upwork Buddy API is running on ${API_BASE_URL}
                    <br><br>
                    <details>
                        <summary>Technical Details</summary>
                        <pre style="font-size: 11px; overflow: auto;">${escapeHtml(error.stack || error.toString())}</pre>
                    </details>
                </div>
            `;
        }
    }
    
    // Initialize
    injectStyles();
    
    // Create and append modal
    const modal = createModal();
    document.body.insertBefore(modal, document.body.firstChild);
    
    // Create and append trigger button
    const trigger = createTriggerButton();
    document.body.appendChild(trigger);
    
    // Create and append View Projects button
    const viewProjectsBtn = createViewProjectsButton();
    document.body.appendChild(viewProjectsBtn);
    
    // Watch for drawer
    watchForDrawer();
    
    console.log('✅ Upwork Buddy activated! Open a job to see the Analyze button.');
})();
