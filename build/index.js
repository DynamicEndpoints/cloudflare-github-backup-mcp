#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError, } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || 'placeholder_cloudflare_token';
const GITHUB_ACCESS_TOKEN = process.env.GITHUB_ACCESS_TOKEN || 'placeholder_github_token';
const GITHUB_REPO_NAME = process.env.GITHUB_REPO_NAME || 'placeholder_repo_name';
class CloudflareBackupServer {
    constructor() {
        this.server = new Server({
            name: 'cloudflare-github-backup',
            version: '0.1.0',
        }, {
            capabilities: {
                tools: {},
            },
        });
        this.cloudflareApi = axios.create({
            baseURL: 'https://api.cloudflare.com/client/v4',
            headers: {
                Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
            },
        });
        this.githubApi = axios.create({
            baseURL: 'https://api.github.com',
            headers: {
                Authorization: `Bearer ${GITHUB_ACCESS_TOKEN}`,
            },
        });
        this.setupToolHandlers();
        this.server.onerror = (error) => console.error('[MCP Error]', error);
        process.on('SIGINT', async () => {
            await this.server.close();
            process.exit(0);
        });
    }
    setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'backup_projects',
                    description: 'Backup Cloudflare projects to GitHub',
                    inputSchema: {
                        type: 'object',
                        properties: {},
                        required: [],
                    },
                },
            ],
        }));
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            if (request.params.name !== 'backup_projects') {
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
            }
            try {
                await this.backupProjects();
                return {
                    content: [{ type: 'text', text: 'Cloudflare projects backed up successfully.' }],
                };
            }
            catch (error) {
                return {
                    content: [{ type: 'text', text: `Error during backup: ${error}` }],
                    isError: true,
                };
            }
        });
    }
    async backupProjects() {
        try {
            console.log('Fetching Cloudflare projects...');
            const projects = await this.fetchCloudflareProjects();
            console.log('Checking for GitHub repository...');
            const repoExists = await this.checkGitHubRepoExists();
            if (!repoExists) {
                console.log('Creating GitHub repository...');
                await this.createGitHubRepo();
            }
            console.log('Backing up projects to GitHub...');
            for (const project of projects) {
                await this.backupProjectToGitHub(project);
            }
            console.log('Backup complete.');
        }
        catch (error) {
            console.error('Error during backup:', error);
            throw new McpError(ErrorCode.InternalError, `Backup failed: ${error}`);
        }
    }
    async fetchCloudflareProjects() {
        try {
            const response = await this.cloudflareApi.get('/zones');
            return response.data.result;
        }
        catch (error) {
            console.error('Error fetching Cloudflare projects:', error);
            throw new McpError(ErrorCode.InternalError, `Failed to fetch Cloudflare projects: ${error}`);
        }
    }
    async checkGitHubRepoExists() {
        var _a;
        try {
            const owner = GITHUB_ACCESS_TOKEN.split(':')[0]; // Assuming format is 'username:token'
            await this.githubApi.get(`/repos/${owner}/${GITHUB_REPO_NAME}`);
            return true;
        }
        catch (error) {
            if (axios.isAxiosError(error) && ((_a = error.response) === null || _a === void 0 ? void 0 : _a.status) === 404) {
                return false;
            }
            console.error('Error checking for GitHub repository:', error);
            throw new McpError(ErrorCode.InternalError, `Failed to check for GitHub repository: ${error}`);
        }
    }
    async createGitHubRepo() {
        try {
            await this.githubApi.post('/user/repos', {
                name: GITHUB_REPO_NAME,
                auto_init: true, // Initialize with a README
            });
        }
        catch (error) {
            console.error('Error creating GitHub repository:', error);
            throw new McpError(ErrorCode.InternalError, `Failed to create GitHub repository: ${error}`);
        }
    }
    async backupProjectToGitHub(project) {
        console.log(`Backing up project: ${project.name} (${project.id})`);
        const projectId = project.id;
        const projectName = project.name;
        // Create a folder for the project in the GitHub repository
        const projectFolder = `cloudflare_backup/${projectName}`;
        // Fetch DNS records
        const dnsRecords = await this.fetchDnsRecords(projectId);
        await this.createOrUpdateFile(`${projectFolder}/dns_records.json`, JSON.stringify(dnsRecords, null, 2));
        // Fetch Page Rules
        const pageRules = await this.fetchPageRules(projectId);
        await this.createOrUpdateFile(`${projectFolder}/page_rules.json`, JSON.stringify(pageRules, null, 2));
        // Fetch Workers
        const workers = await this.fetchWorkers(projectId);
        for (const worker of workers) {
            await this.createOrUpdateFile(`${projectFolder}/workers/${worker.id}.js`, worker.script);
        }
        // Fetch Custom Pages
        const customPages = await this.fetchCustomPages(projectId);
        await this.createOrUpdateFile(`${projectFolder}/custom_pages.json`, JSON.stringify(customPages, null, 2));
        // Fetch SSL/TLS settings
        const sslTlsSettings = await this.fetchSslTlsSettings(projectId);
        await this.createOrUpdateFile(`${projectFolder}/ssl_tls_settings.json`, JSON.stringify(sslTlsSettings, null, 2));
        // Fetch Firewall Rules
        const firewallRules = await this.fetchFirewallRules(projectId);
        await this.createOrUpdateFile(`${projectFolder}/firewall_rules.json`, JSON.stringify(firewallRules, null, 2));
        // Fetch Access Rules
        const accessRules = await this.fetchAccessRules(projectId);
        await this.createOrUpdateFile(`${projectFolder}/access_rules.json`, JSON.stringify(accessRules, null, 2));
        // Fetch Rate Limiting Rules
        const rateLimitRules = await this.fetchRateLimitRules(projectId);
        await this.createOrUpdateFile(`${projectFolder}/rate_limit_rules.json`, JSON.stringify(rateLimitRules, null, 2));
        console.log(`Project ${projectName} backed up successfully.`);
    }
    async fetchDnsRecords(projectId) {
        try {
            const response = await this.cloudflareApi.get(`/zones/${projectId}/dns_records`);
            return response.data.result;
        }
        catch (error) {
            console.error(`Error fetching DNS records for project ${projectId}:`, error);
            throw new McpError(ErrorCode.InternalError, `Failed to fetch DNS records for project ${projectId}: ${error}`);
        }
    }
    async fetchPageRules(projectId) {
        try {
            const response = await this.cloudflareApi.get(`/zones/${projectId}/pagerules`);
            return response.data.result;
        }
        catch (error) {
            console.error(`Error fetching Page Rules for project ${projectId}:`, error);
            throw new McpError(ErrorCode.InternalError, `Failed to fetch Page Rules for project ${projectId}: ${error}`);
        }
    }
    async fetchWorkers(projectId) {
        try {
            const routesResponse = await this.cloudflareApi.get(`/zones/${projectId}/workers/routes`);
            const routes = routesResponse.data.result;
            const workers = [];
            for (const route of routes) {
                const scriptName = route.script;
                const scriptResponse = await this.cloudflareApi.get(`/zones/${projectId}/workers/scripts/${scriptName}`);
                const scriptContent = scriptResponse.data;
                workers.push({
                    id: scriptName,
                    script: scriptContent,
                });
            }
            return workers;
        }
        catch (error) {
            console.error(`Error fetching Workers for project ${projectId}:`, error);
            throw new McpError(ErrorCode.InternalError, `Failed to fetch Workers for project ${projectId}: ${error}`);
        }
    }
    async fetchCustomPages(projectId) {
        try {
            const response = await this.cloudflareApi.get(`/zones/${projectId}/custom_pages`);
            return response.data.result;
        }
        catch (error) {
            console.error(`Error fetching Custom Pages for project ${projectId}:`, error);
            throw new McpError(ErrorCode.InternalError, `Failed to fetch Custom Pages for project ${projectId}: ${error}`);
        }
    }
    async fetchSslTlsSettings(projectId) {
        try {
            const response = await this.cloudflareApi.get(`/zones/${projectId}/settings`);
            const settings = response.data.result;
            // Filter out SSL/TLS related settings
            const sslTlsSettings = settings.filter((setting) => setting.id.startsWith('ssl') || setting.id.startsWith('tls'));
            return sslTlsSettings;
        }
        catch (error) {
            console.error(`Error fetching SSL/TLS settings for project ${projectId}:`, error);
            throw new McpError(ErrorCode.InternalError, `Failed to fetch SSL/TLS settings for project ${projectId}: ${error}`);
        }
    }
    async fetchFirewallRules(projectId) {
        try {
            const response = await this.cloudflareApi.get(`/zones/${projectId}/firewall/rules`);
            return response.data.result;
        }
        catch (error) {
            console.error(`Error fetching Firewall Rules for project ${projectId}:`, error);
            throw new McpError(ErrorCode.InternalError, `Failed to fetch Firewall Rules for project ${projectId}: ${error}`);
        }
    }
    async fetchAccessRules(projectId) {
        try {
            const response = await this.cloudflareApi.get(`/zones/${projectId}/firewall/access_rules/rules`);
            return response.data.result;
        }
        catch (error) {
            console.error(`Error fetching Access Rules for project ${projectId}:`, error);
            throw new McpError(ErrorCode.InternalError, `Failed to fetch Access Rules for project ${projectId}: ${error}`);
        }
    }
    async fetchRateLimitRules(projectId) {
        try {
            const response = await this.cloudflareApi.get(`/zones/${projectId}/rate_limits`);
            return response.data.result;
        }
        catch (error) {
            console.error(`Error fetching Rate Limiting Rules for project ${projectId}:`, error);
            throw new McpError(ErrorCode.InternalError, `Failed to fetch Rate Limiting Rules for project ${projectId}: ${error}`);
        }
    }
    async createOrUpdateFile(path, content, message = 'chore(backup): update backup') {
        var _a;
        const owner = GITHUB_ACCESS_TOKEN.split(':')[0];
        const ref = 'heads/main'; // Assuming we are committing to the main branch
        try {
            // Check if the file exists
            const { data: existingFile } = await this.githubApi.get(`/repos/${owner}/${GITHUB_REPO_NAME}/contents/${path}`, {
                params: {
                    ref,
                },
            });
            // If the file exists, update it
            await this.githubApi.put(`/repos/${owner}/${GITHUB_REPO_NAME}/contents/${path}`, {
                message,
                content: Buffer.from(content).toString('base64'),
                sha: existingFile.sha,
                branch: 'main',
            });
        }
        catch (error) {
            if (axios.isAxiosError(error) && ((_a = error.response) === null || _a === void 0 ? void 0 : _a.status) === 404) {
                // If the file does not exist, create it
                await this.githubApi.put(`/repos/${owner}/${GITHUB_REPO_NAME}/contents/${path}`, {
                    message,
                    content: Buffer.from(content).toString('base64'),
                    branch: 'main',
                });
            }
            else {
                console.error(`Error creating or updating file ${path}:`, error);
                throw new McpError(ErrorCode.InternalError, `Failed to create or update file ${path}: ${error}`);
            }
        }
    }
    // TODO: Implement restore functionality
    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('Cloudflare Backup MCP server running on stdio');
    }
}
const server = new CloudflareBackupServer();
server.run().catch(console.error);
//# sourceMappingURL=index.js.map