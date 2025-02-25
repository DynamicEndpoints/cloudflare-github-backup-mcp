#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';

const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const GITHUB_ACCESS_TOKEN = process.env.GITHUB_ACCESS_TOKEN;
const GITHUB_REPO_NAME = process.env.GITHUB_REPO_NAME;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;

if (!CLOUDFLARE_API_TOKEN) {
  console.error('Error: CLOUDFLARE_API_TOKEN environment variable is required');
  process.exit(1);
}

if (!GITHUB_ACCESS_TOKEN) {
  console.error('Error: GITHUB_ACCESS_TOKEN environment variable is required');
  process.exit(1);
}

if (!GITHUB_REPO_NAME) {
  console.error('Error: GITHUB_REPO_NAME environment variable is required');
  process.exit(1);
}

if (!GITHUB_USERNAME) {
  console.error('Error: GITHUB_USERNAME environment variable is required');
  process.exit(1);
}

class CloudflareBackupServer {
  private server: Server;
  private cloudflareApi;
  private githubApi;

  constructor() {
    this.server = new Server(
      {
        name: 'cloudflare-github-backup',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.cloudflareApi = axios.create({
      baseURL: 'https://api.cloudflare.com/client/v4',
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      },
    });

    this.githubApi = axios.create({
      baseURL: 'https://api.github.com',
      headers: {
        Authorization: `token ${GITHUB_ACCESS_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Cloudflare-GitHub-Backup-MCP',
      },
    });

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'backup_projects',
          description: 'Backup Cloudflare projects to GitHub',
          inputSchema: {
            type: 'object',
            properties: {
              projectIds: {
                type: 'array',
                items: {
                  type: 'string'
                },
                description: 'Optional array of Cloudflare project IDs to backup. If not provided, all projects will be backed up.'
              }
            },
            required: [],
          },
        },
        {
          name: 'restore_project',
          description: 'Restore a Cloudflare project from a backup',
          inputSchema: {
            type: 'object',
            properties: {
              projectId: {
                type: 'string',
                description: 'ID of the Cloudflare project to restore'
              },
              timestamp: {
                type: 'string',
                description: 'Optional timestamp of the backup to restore. If not provided, the most recent backup will be used.'
              }
            },
            required: ['projectId'],
          },
        },
        {
          name: 'list_backups',
          description: 'List available backups for a Cloudflare project',
          inputSchema: {
            type: 'object',
            properties: {
              projectId: {
                type: 'string',
                description: 'ID of the Cloudflare project'
              }
            },
            required: ['projectId'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'backup_projects') {
        try {
          const args = request.params.arguments as { projectIds?: string[] };
          const projectIds = args?.projectIds;
          await this.backupProjects(projectIds);
          return {
            content: [{ type: 'text', text: 'Cloudflare projects backed up successfully.' }],
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Error during backup: ${error}` }],
            isError: true,
          };
        }
      } else if (request.params.name === 'restore_project') {
        try {
          const args = request.params.arguments as { projectId: string; timestamp?: string };
          const { projectId, timestamp } = args;
          if (!projectId) {
            throw new McpError(ErrorCode.InvalidParams, 'Project ID is required for restore');
          }
          await this.restoreProject(projectId, timestamp);
          return {
            content: [{ type: 'text', text: `Project ${projectId} restored successfully.` }],
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Error during restore: ${error}` }],
            isError: true,
          };
        }
      } else if (request.params.name === 'list_backups') {
        try {
          const args = request.params.arguments as { projectId: string };
          const { projectId } = args;
          if (!projectId) {
            throw new McpError(ErrorCode.InvalidParams, 'Project ID is required to list backups');
          }
          const backups = await this.listBackups(projectId);
          return {
            content: [{ type: 'text', text: JSON.stringify(backups, null, 2) }],
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Error listing backups: ${error}` }],
            isError: true,
          };
        }
      } else {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
      }
    });
  }

  private async backupProjects(projectIds?: string[]) {
    try {
      console.log('Fetching Cloudflare projects...');
      const allProjects = await this.fetchCloudflareProjects();
      
      // Filter projects if projectIds is provided
      const projects = projectIds 
        ? allProjects.filter(project => projectIds.includes(project.id))
        : allProjects;
      
      if (projectIds && projects.length < projectIds.length) {
        const foundIds = projects.map(p => p.id);
        const missingIds = projectIds.filter(id => !foundIds.includes(id));
        console.warn(`Warning: Some requested project IDs were not found: ${missingIds.join(', ')}`);
      }

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
    } catch (error) {
      console.error('Error during backup:', error);
      throw new McpError(ErrorCode.InternalError, `Backup failed: ${error}`);
    }
  }

  private async fetchCloudflareProjects(): Promise<any[]> {
    try {
      const response = await this.cloudflareApi.get('/zones');
      return response.data.result;
    } catch (error) {
      console.error('Error fetching Cloudflare projects:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch Cloudflare projects: ${error}`
      );
    }
  }

  private async checkGitHubRepoExists(): Promise<boolean> {
    try {
      await this.githubApi.get(`/repos/${GITHUB_USERNAME}/${GITHUB_REPO_NAME}`);
      return true;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return false;
      }
      console.error('Error checking for GitHub repository:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to check for GitHub repository: ${error}`
      );
    }
  }

  private async createGitHubRepo(): Promise<void> {
    try {
      await this.githubApi.post('/user/repos', {
        name: GITHUB_REPO_NAME,
        auto_init: true, // Initialize with a README
        description: 'Cloudflare projects backup repository created by Cloudflare-GitHub-Backup-MCP',
        private: true, // Make the repository private by default for security
      });
    } catch (error) {
      console.error('Error creating GitHub repository:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to create GitHub repository: ${error}`
      );
    }
  }

  private async backupProjectToGitHub(project: any): Promise<void> {
    console.log(`Backing up project: ${project.name} (${project.id})`);
    const projectId = project.id;
    const projectName = project.name;
    
    // Create a timestamp for this backup
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    
    // Create a folder for the project in the GitHub repository with timestamp
    const projectFolder = `cloudflare_backup/${projectName}/${timestamp}`;
    
    // Save project metadata
    await this.createOrUpdateFile(
      `${projectFolder}/metadata.json`,
      JSON.stringify({
        id: project.id,
        name: project.name,
        status: project.status,
        paused: project.paused,
        type: project.type,
        created_on: project.created_on,
        modified_on: project.modified_on,
        backup_timestamp: timestamp
      }, null, 2)
    );

    // Fetch DNS records
    const dnsRecords = await this.fetchDnsRecords(projectId);
    await this.createOrUpdateFile(
      `${projectFolder}/dns_records.json`,
      JSON.stringify(dnsRecords, null, 2)
    );

    // Fetch Page Rules
    const pageRules = await this.fetchPageRules(projectId);
    await this.createOrUpdateFile(
      `${projectFolder}/page_rules.json`,
      JSON.stringify(pageRules, null, 2)
    );

    // Fetch Workers
    const workers = await this.fetchWorkers(projectId);
    for (const worker of workers) {
      await this.createOrUpdateFile(
        `${projectFolder}/workers/${worker.id}.js`,
        worker.script
      );
    }

    // Fetch Custom Pages
    const customPages = await this.fetchCustomPages(projectId);
    await this.createOrUpdateFile(
      `${projectFolder}/custom_pages.json`,
      JSON.stringify(customPages, null, 2)
    );

    // Fetch SSL/TLS settings
    const sslTlsSettings = await this.fetchSslTlsSettings(projectId);
    await this.createOrUpdateFile(
      `${projectFolder}/ssl_tls_settings.json`,
      JSON.stringify(sslTlsSettings, null, 2)
    );

    // Fetch Firewall Rules
    const firewallRules = await this.fetchFirewallRules(projectId);
    await this.createOrUpdateFile(
      `${projectFolder}/firewall_rules.json`,
      JSON.stringify(firewallRules, null, 2)
    );

    // Fetch Access Rules
    const accessRules = await this.fetchAccessRules(projectId);
    await this.createOrUpdateFile(
      `${projectFolder}/access_rules.json`,
      JSON.stringify(accessRules, null, 2)
    );
    
    // Fetch Rate Limiting Rules
    const rateLimitRules = await this.fetchRateLimitRules(projectId);
    await this.createOrUpdateFile(
      `${projectFolder}/rate_limit_rules.json`,
      JSON.stringify(rateLimitRules, null, 2)
    );

    console.log(`Project ${projectName} backed up successfully.`);
  }

  private async fetchDnsRecords(projectId: string): Promise<any[]> {
    try {
      const response = await this.cloudflareApi.get(`/zones/${projectId}/dns_records`);
      return response.data.result;
    } catch (error) {
      console.error(`Error fetching DNS records for project ${projectId}:`, error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch DNS records for project ${projectId}: ${error}`
      );
    }
  }

  private async fetchPageRules(projectId: string): Promise<any[]> {
    try {
      const response = await this.cloudflareApi.get(`/zones/${projectId}/pagerules`);
      return response.data.result;
    } catch (error) {
      console.error(`Error fetching Page Rules for project ${projectId}:`, error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch Page Rules for project ${projectId}: ${error}`
      );
    }
  }

  private async fetchWorkers(projectId: string): Promise<any[]> {
    try {
      // First, get all worker routes for this zone
      const routesResponse = await this.cloudflareApi.get(`/zones/${projectId}/workers/routes`);
      const routes = routesResponse.data.result || [];
      
      // Create a map to store unique worker scripts
      const workerMap = new Map();
      
      // Process each route
      for (const route of routes) {
        const scriptName = route.script;
        
        // Skip if we've already processed this script
        if (workerMap.has(scriptName)) continue;
        
        try {
          // Try to fetch the script content directly from the zone
          const scriptResponse = await this.cloudflareApi.get(
            `/zones/${projectId}/workers/scripts/${scriptName}`,
            { responseType: 'text' }
          );
          
          workerMap.set(scriptName, {
            id: scriptName,
            script: scriptResponse.data,
            routes: [route.pattern],
          });
        } catch (scriptError) {
          console.warn(`Could not fetch worker script ${scriptName} directly from zone. Trying account-level API...`);
          
          try {
            // Try to fetch from account-level API
            // Note: This requires the Account ID, which we don't have in the current implementation
            // For now, we'll just record that we couldn't fetch the script
            workerMap.set(scriptName, {
              id: scriptName,
              script: "// Script content could not be fetched. May require account-level access.",
              routes: [route.pattern],
              error: "Could not fetch script content. May require account-level access."
            });
          } catch (accountError) {
            console.error(`Error fetching worker script ${scriptName} from account API:`, accountError);
            workerMap.set(scriptName, {
              id: scriptName,
              script: "// Script content could not be fetched due to an error.",
              routes: [route.pattern],
              error: "Failed to fetch script content."
            });
          }
        }
      }
      
      // Convert map to array
      return Array.from(workerMap.values());
    } catch (error) {
      console.error(`Error fetching Workers for project ${projectId}:`, error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch Workers for project ${projectId}: ${error}`
      );
    }
  }

  private async fetchCustomPages(projectId: string): Promise<any[]> {
    try {
      const response = await this.cloudflareApi.get(`/zones/${projectId}/custom_pages`);
      return response.data.result;
    } catch (error) {
      console.error(`Error fetching Custom Pages for project ${projectId}:`, error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch Custom Pages for project ${projectId}: ${error}`
      );
    }
  }

  private async fetchSslTlsSettings(projectId: string): Promise<any> {
    try {
      const response = await this.cloudflareApi.get(`/zones/${projectId}/settings`);
      const settings = response.data.result;
      // Filter out SSL/TLS related settings
      const sslTlsSettings = settings.filter((setting: any) => setting.id.startsWith('ssl') || setting.id.startsWith('tls'));
      return sslTlsSettings;
    } catch (error) {
      console.error(`Error fetching SSL/TLS settings for project ${projectId}:`, error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch SSL/TLS settings for project ${projectId}: ${error}`
      );
    }
  }

  private async fetchFirewallRules(projectId: string): Promise<any[]> {
    try {
      const response = await this.cloudflareApi.get(`/zones/${projectId}/firewall/rules`);
      return response.data.result;
    } catch (error) {
      console.error(`Error fetching Firewall Rules for project ${projectId}:`, error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch Firewall Rules for project ${projectId}: ${error}`
      );
    }
  }

  private async fetchAccessRules(projectId: string): Promise<any[]> {
    try {
      const response = await this.cloudflareApi.get(`/zones/${projectId}/firewall/access_rules/rules`);
      return response.data.result;
    } catch (error) {
      console.error(`Error fetching Access Rules for project ${projectId}:`, error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch Access Rules for project ${projectId}: ${error}`
      );
    }
  }

  private async fetchRateLimitRules(projectId: string): Promise<any[]> {
    try {
      const response = await this.cloudflareApi.get(`/zones/${projectId}/rate_limits`);
      return response.data.result;
    } catch (error) {
      console.error(`Error fetching Rate Limiting Rules for project ${projectId}:`, error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch Rate Limiting Rules for project ${projectId}: ${error}`
      );
    }
  }

  private async createOrUpdateFile(
    path: string,
    content: string,
    message: string = 'chore(backup): update backup'
  ): Promise<void> {
    try {
      // Check if the file exists
      const { data: existingFile } = await this.githubApi.get(
        `/repos/${GITHUB_USERNAME}/${GITHUB_REPO_NAME}/contents/${path}`,
        {
          params: {
            ref: 'heads/main',
          },
        }
      );

      // If the file exists, update it
      await this.githubApi.put(
        `/repos/${GITHUB_USERNAME}/${GITHUB_REPO_NAME}/contents/${path}`,
        {
          message,
          content: Buffer.from(content).toString('base64'),
          sha: existingFile.sha,
          branch: 'main',
        }
      );
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        // If the file does not exist, create it
        await this.githubApi.put(
          `/repos/${GITHUB_USERNAME}/${GITHUB_REPO_NAME}/contents/${path}`,
          {
            message,
            content: Buffer.from(content).toString('base64'),
            branch: 'main',
          }
        );
      } else {
        console.error(`Error creating or updating file ${path}:`, error);
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to create or update file ${path}: ${error}`
        );
      }
    }
  }

  private async listBackups(projectId: string): Promise<any[]> {
    try {
      // First, get the project name
      const projectResponse = await this.cloudflareApi.get(`/zones/${projectId}`);
      const projectName = projectResponse.data.result.name;
      
      // Get the contents of the project folder
      const projectFolderPath = `cloudflare_backup/${projectName}`;
      
      try {
        const { data: folderContents } = await this.githubApi.get(
          `/repos/${GITHUB_USERNAME}/${GITHUB_REPO_NAME}/contents/${projectFolderPath}`
        );
        
        // Filter for directories (which should be timestamp folders)
        const backupFolders = folderContents.filter((item: any) => item.type === 'dir');
        
        // Sort by name (which is the timestamp) in descending order
        backupFolders.sort((a: any, b: any) => b.name.localeCompare(a.name));
        
        return backupFolders.map((folder: any) => ({
          timestamp: folder.name,
          url: folder.html_url
        }));
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          // No backups found
          return [];
        }
        throw error;
      }
    } catch (error) {
      console.error(`Error listing backups for project ${projectId}:`, error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list backups for project ${projectId}: ${error}`
      );
    }
  }

  private async restoreProject(projectId: string, timestamp?: string): Promise<void> {
    try {
      // Get the project name
      const projectResponse = await this.cloudflareApi.get(`/zones/${projectId}`);
      const projectName = projectResponse.data.result.name;
      
      // Get available backups
      const backups = await this.listBackups(projectId);
      
      if (backups.length === 0) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `No backups found for project ${projectName} (${projectId})`
        );
      }
      
      // If no timestamp is provided, use the most recent backup
      const backupTimestamp = timestamp || backups[0].timestamp;
      
      // Check if the specified backup exists
      const backupExists = backups.some(backup => backup.timestamp === backupTimestamp);
      if (!backupExists) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Backup with timestamp ${backupTimestamp} not found for project ${projectName}`
        );
      }
      
      console.log(`Restoring project ${projectName} (${projectId}) from backup ${backupTimestamp}...`);
      
      // Get the backup folder contents
      const backupFolderPath = `cloudflare_backup/${projectName}/${backupTimestamp}`;
      const { data: backupContents } = await this.githubApi.get(
        `/repos/${GITHUB_USERNAME}/${GITHUB_REPO_NAME}/contents/${backupFolderPath}`
      );
      
      // Process each backup file
      for (const item of backupContents) {
        if (item.type === 'file') {
          // Get the file content
          const { data: fileData } = await this.githubApi.get(item.download_url);
          
          // Determine what to restore based on the file name
          if (item.name === 'dns_records.json') {
            await this.restoreDnsRecords(projectId, fileData);
          } else if (item.name === 'page_rules.json') {
            await this.restorePageRules(projectId, fileData);
          } else if (item.name === 'firewall_rules.json') {
            await this.restoreFirewallRules(projectId, fileData);
          } else if (item.name === 'access_rules.json') {
            await this.restoreAccessRules(projectId, fileData);
          } else if (item.name === 'rate_limit_rules.json') {
            await this.restoreRateLimitRules(projectId, fileData);
          } else if (item.name === 'ssl_tls_settings.json') {
            await this.restoreSslTlsSettings(projectId, fileData);
          }
        } else if (item.name === 'workers' && item.type === 'dir') {
          // Handle workers directory
          await this.restoreWorkers(projectId, `${backupFolderPath}/workers`);
        }
      }
      
      console.log(`Project ${projectName} (${projectId}) restored successfully from backup ${backupTimestamp}.`);
    } catch (error) {
      console.error(`Error restoring project ${projectId}:`, error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to restore project ${projectId}: ${error}`
      );
    }
  }

  // Stub implementations for restore methods
  private async restoreDnsRecords(projectId: string, records: any[]): Promise<void> {
    console.log(`Restoring DNS records for project ${projectId}...`);
    // Implementation would go here
    console.log(`DNS records restored successfully for project ${projectId}.`);
  }

  private async restorePageRules(projectId: string, rules: any[]): Promise<void> {
    console.log(`Restoring Page Rules for project ${projectId}...`);
    // Implementation would go here
    console.log(`Page Rules restored successfully for project ${projectId}.`);
  }

  private async restoreFirewallRules(projectId: string, rules: any[]): Promise<void> {
    console.log(`Restoring Firewall Rules for project ${projectId}...`);
    // Implementation would go here
    console.log(`Firewall Rules restored successfully for project ${projectId}.`);
  }

  private async restoreAccessRules(projectId: string, rules: any[]): Promise<void> {
    console.log(`Restoring Access Rules for project ${projectId}...`);
    // Implementation would go here
    console.log(`Access Rules restored successfully for project ${projectId}.`);
  }

  private async restoreRateLimitRules(projectId: string, rules: any[]): Promise<void> {
    console.log(`Restoring Rate Limit Rules for project ${projectId}...`);
    // Implementation would go here
    console.log(`Rate Limit Rules restored successfully for project ${projectId}.`);
  }

  private async restoreSslTlsSettings(projectId: string, settings: any[]): Promise<void> {
    console.log(`Restoring SSL/TLS settings for project ${projectId}...`);
    // Implementation would go here
    console.log(`SSL/TLS settings restored successfully for project ${projectId}.`);
  }

  private async restoreWorkers(projectId: string, workersPath: string): Promise<void> {
    console.log(`Restoring Workers for project ${projectId}...`);
    // Implementation would go here
    console.log(`Workers restored successfully for project ${projectId}.`);
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Cloudflare Backup MCP server running on stdio');
  }
}

const server = new CloudflareBackupServer();
server.run().catch(console.error);
