import { Injectable, NotFoundException } from '@nestjs/common';
import * as os from 'os';
import * as _ from 'lodash';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as child_process from 'child_process';
import * as semver from 'semver';
import * as rp from 'request-promise';
import * as color from 'bash-color';
import * as pty from 'node-pty-prebuilt-multiarch';

import { Logger } from '../../core/logger/logger.service';
import { ConfigService } from '../../core/config/config.service';

export interface HomebridgePlugin {
  name: string;
  description?: string;
  certifiedPlugin?: boolean;
  publicPackage?: boolean;
  installedVersion?: string;
  latestVersion?: boolean;
  lastUpdated?: string;
  updateAvailable?: boolean;
  installPath?: string;
  globalInstall?: boolean;
  settingsSchema?: boolean;
  links?: {
    npm?: string;
    homepage?: string;
    bugs?: string;
  };
  author?: string;
}

@Injectable()
export class PluginsService {
  private npm: Array<string> = this.getNpmPath();
  private paths: Array<string> = this.getBasePaths();

  // installed plugin cache
  private installedPlugins: HomebridgePlugin[];

  // setup requests with default options
  private rp = rp.defaults({
    json: true,
    headers: {
      'User-Agent': this.configService.package.name,
    },
    timeout: 5000,
  });

  constructor(
    private configService: ConfigService,
    private logger: Logger,
  ) { }

  /**
   * Return an array of plugins currently installed
   */
  public async getInstalledPlugins(): Promise<HomebridgePlugin[]> {
    const plugins: HomebridgePlugin[] = [];
    const modules = await this.getInstalledModules();

    // filter out non-homebridge plugins by name
    const homebridgePlugins = modules
      .filter(module => (module.name.indexOf('homebridge-') === 0))
      .filter(async module => (await fs.pathExists(path.join(module.installPath, 'package.json')).catch(x => null)))
      .filter(x => x);

    await Promise.all(homebridgePlugins.map(async (pkg) => {
      try {
        const pjson = await fs.readJson(path.join(pkg.installPath, 'package.json'));
        // check each plugin has the 'homebridge-plugin' keyword
        if (pjson.keywords && pjson.keywords.includes('homebridge-plugin')) {
          // parse the package.json for each plugin
          const plugin = await this.parsePackageJson(pjson, pkg.path);

          // filter out duplicate plugins and give preference to non-global plugins
          if (!plugins.find(x => plugin.name === x.name)) {
            plugins.push(plugin);
          } else if (!plugin.globalInstall && plugins.find(x => plugin.name === x.name && x.globalInstall === true)) {
            const index = plugins.findIndex(x => plugin.name === x.name && x.globalInstall === true);
            plugins[index] = plugin;
          }
        }
      } catch (e) {
        this.logger.error(`Failed to parse plugin "${pkg.name}": ${e.message}`);
      }
    }));

    this.installedPlugins = plugins;
    return _.orderBy(plugins, ['updateAvailable', 'name'], ['desc', 'asc']);
  }

  /**
   * Returns an array of out-of-date plugins
   */
  public async getOutOfDatePlugins(): Promise<HomebridgePlugin[]> {
    const plugins = await this.getInstalledPlugins();
    return plugins.filter(x => x.updateAvailable);
  }

  /**
   * Search the npm registry for homebridge plugins
   * @param query
   */
  public async searchNpmRegistry(query: string): Promise<HomebridgePlugin[]> {
    if (!this.installedPlugins) {
      await this.getInstalledPlugins();
    }

    const q = ((!query || !query.length) ? '' : query + '+') + 'keywords:homebridge-plugin+not:deprecated&size=30';
    const searchResults = await this.rp.get(`https://registry.npmjs.org/-/v1/search?text=${q}`);

    const result: HomebridgePlugin[] = searchResults.objects
      .filter(x => x.package.name.indexOf('homebridge-') === 0)
      .map((pkg) => {
        let plugin: HomebridgePlugin = {
          name: pkg.package.name,
        };

        // see if the plugin is already installed
        const isInstalled = this.installedPlugins.find(x => x.name === plugin.name);
        if (isInstalled) {
          plugin = isInstalled;
          return plugin;
        }

        // it's not installed; finish building the response
        plugin.publicPackage = true;
        plugin.installedVersion = null;
        plugin.latestVersion = pkg.package.version;
        plugin.lastUpdated = pkg.package.date;
        plugin.description = (pkg.package.description) ?
          pkg.package.description.replace(/(?:https?|ftp):\/\/[\n\S]+/g, '').trim() : pkg.package.name;
        plugin.links = pkg.package.links;
        plugin.author = (pkg.package.publisher) ? pkg.package.publisher.username : null;
        plugin.certifiedPlugin = (pkg.package.name.indexOf('@homebridge/homebridge-') === 0);

        return plugin;
      });

    if (!result.length && query.indexOf('homebridge-') === 0) {
      return await this.searchNpmRegistrySingle(query);
    }

    return result;
  }

  /**
   * Get a single plugin from the registry using it's exact name
   * Used as a fallback if the search queries are not finding the desired plugin
   * @param query
   */
  async searchNpmRegistrySingle(query: string): Promise<HomebridgePlugin[]> {
    try {
      const pkg = await this.rp.get(`https://registry.npmjs.org/${encodeURIComponent(query).replace('%40', '@')}`);
      if (!pkg.keywords || !pkg.keywords.includes('homebridge-plugin')) {
        return [];
      }

      let plugin: HomebridgePlugin;

      // see if the plugin is already installed
      const isInstalled = this.installedPlugins.find(x => x.name === pkg.name);
      if (isInstalled) {
        plugin = isInstalled;
        return [plugin];
      }

      plugin = {
        name: pkg.name,
        description: (pkg.description) ?
          pkg.description.replace(/(?:https?|ftp):\/\/[\n\S]+/g, '').trim() : pkg.name,
        certifiedPlugin: (pkg.name.indexOf('@homebridge/homebridge-') === 0),
      } as HomebridgePlugin;

      // it's not installed; finish building the response
      plugin.publicPackage = true;
      plugin.latestVersion = pkg['dist-tags'].latest;
      plugin.lastUpdated = pkg.package.date;
      plugin.updateAvailable = false;
      plugin.links = {
        npm: `https://www.npmjs.com/package/${plugin.name}`,
        homepage: pkg.homepage,
        bugs: (pkg.bugs) ? pkg.bugs.url : null,
      };
      plugin.author = (pkg.maintainers.length) ? pkg.maintainers[0].name : null;
      plugin.certifiedPlugin = (pkg.name.indexOf('@homebridge/homebridge-') === 0);

      return [plugin];
    } catch (e) {
      if (e.statusCode !== 404) {
        this.logger.error('Failed to search npm registry');
        this.logger.error(e.message);
      }
      return [];
    }
  }

  /**
   * Installs the requested plugin with NPM
   * @param pluginName
   * @param client
   */
  async installPlugin(pluginName: string, client) {
    await this.getInstalledPlugins();

    // install new plugins in the same location as this plugin
    let installPath = (this.configService.customPluginPath) ?
      this.configService.customPluginPath : this.installedPlugins.find(x => x.name === this.configService.name).installPath;

    // prepare flags for npm command
    const installOptions: Array<string> = [];

    // check to see if custom plugin path is using a package.json file
    if (installPath === this.configService.customPluginPath && await fs.pathExists(path.resolve(installPath, '../package.json'))) {
      installOptions.push('--save');
    }

    installPath = path.resolve(installPath, '../');

    await this.runNpmCommand([...this.npm, 'install', '--unsafe-perm', ...installOptions, `${pluginName}@latest`], installPath, client);

    return true;
  }

  /**
   * Removes the requested plugin with NPM
   * @param pluginName
   * @param client
   */
  async uninstallPlugin(pluginName: string, client) {
    await this.getInstalledPlugins();
    // find the plugin
    const plugin = this.installedPlugins.find(x => x.name === pluginName);
    if (!plugin) {
      throw new Error(`Plugin "${pluginName}" Not Found`);
    }

    // get the currently installed
    let installPath = plugin.installPath;

    // prepare flags for npm command
    const installOptions: Array<string> = [];

    // check to see if custom plugin path is using a package.json file
    if (installPath === this.configService.customPluginPath && await fs.pathExists(path.resolve(installPath, '../package.json'))) {
      installOptions.push('--save');
    }

    installPath = path.resolve(installPath, '../');

    await this.runNpmCommand([...this.npm, 'uninstall', '--unsafe-perm', ...installOptions, pluginName], installPath, client);
    await this.ensureCustomPluginDirExists();

    return true;
  }

  /**
   * Updates the requested plugin with NPM
   * @param pluginName
   * @param client
   */
  async updatePlugin(pluginName: string, client) {
    await this.getInstalledPlugins();
    // find the plugin
    const plugin = this.installedPlugins.find(x => x.name === pluginName);
    if (!plugin) {
      throw new Error(`Plugin "${pluginName}" Not Found`);
    }

    // get the currently installed
    let installPath = plugin.installPath;

    // prepare flags for npm command
    const installOptions: Array<string> = [];

    // check to see if custom plugin path is using a package.json file
    if (installPath === this.configService.customPluginPath && await fs.pathExists(path.resolve(installPath, '../package.json'))) {
      installOptions.push('--save');
    }

    installPath = path.resolve(installPath, '../');

    await this.runNpmCommand([...this.npm, 'install', '--unsafe-perm', ...installOptions, `${pluginName}@latest`], installPath, client);

    return true;
  }

  /**
   * Gets the Homebridge package details
   */
  public async getHomebridgePackage() {
    // try load from the "homebridgePackagePath" option first
    if (this.configService.ui.homebridgePackagePath) {
      const pjsonPath = path.join(this.configService.ui.homebridgePackagePath, 'package.json');
      if (await fs.pathExists(pjsonPath)) {
        return await this.parsePackageJson(await fs.readJson(pjsonPath), this.configService.ui.homebridgePackagePath);
      } else {
        this.logger.error(`"homebridgePath" (${this.configService.ui.homebridgePackagePath}) does not exist`);
      }
    }

    const modules = await this.getInstalledModules();

    const homebridgeInstalls = modules.filter(x => x.name === 'homebridge');

    if (homebridgeInstalls.length > 1) {
      this.logger.warn('Multiple Instances Of Homebridge Found Installed');
      homebridgeInstalls.forEach((instance) => {
        this.logger.warn(instance.installPath);
      });
    }

    if (!homebridgeInstalls.length) {
      this.logger.error('Unable To Find Homebridge Installation');
      throw new Error('Unable To Find Homebridge Installation');
    }

    const homebridgeModule = homebridgeInstalls[0];
    const pjson = await fs.readJson(path.join(homebridgeModule.installPath, 'package.json'));
    const homebridge = await this.parsePackageJson(pjson, homebridgeModule.path);

    return homebridge;
  }

  /**
   * Updates the Homebridge package
   */
  public async updateHomebridgePackage(client) {
    const homebridge = await this.getHomebridgePackage();

    // get the currently installed
    let installPath = homebridge.installPath;

    // prepare flags for npm command
    const installOptions: Array<string> = [];

    // check to see if custom plugin path is using a package.json file
    if (installPath === this.configService.customPluginPath && await fs.pathExists(path.resolve(installPath, '../package.json'))) {
      installOptions.push('--save');
    }

    installPath = path.resolve(installPath, '../');

    await this.runNpmCommand([...this.npm, 'install', '--unsafe-perm', ...installOptions, `${homebridge.name}@latest`], installPath, client);

    return true;
  }

  /**
   * Returns the config.schema.json for the plugin
   * @param pluginName
   */
  public async getPluginConfigSchema(pluginName: string) {
    if (!this.installedPlugins) await this.getInstalledPlugins();
    const plugin = this.installedPlugins.find(x => x.name === pluginName);
    if (!plugin) {
      throw new NotFoundException();
    }

    const schemaPath = path.resolve(plugin.installPath, pluginName, 'config.schema.json');

    if (await fs.pathExists(schemaPath)) {
      const configSchema = await fs.readJson(schemaPath);

      // modify this plugins schema to set the default port number
      if (pluginName === this.configService.name) {
        configSchema.schema.properties.port.default = this.configService.ui.port;
      }

      // modify homebridge-alexa to set the default pin
      if (pluginName === 'homebridge-alexa') {
        configSchema.schema.properties.pin.default = this.configService.homebridgeConfig.bridge.pin;
      }

      return configSchema;
    } else {
      throw new NotFoundException();
    }
  }

  /**
   * Returns the changelog from the npm package for a plugin
   * @param pluginName
   */
  public async getPluginChangeLog(pluginName: string) {
    await this.getInstalledPlugins();
    const plugin = this.installedPlugins.find(x => x.name === pluginName);
    if (!plugin) {
      throw new NotFoundException();
    }

    const changeLog = path.resolve(plugin.installPath, plugin.name, 'CHANGELOG.md');

    if (await fs.pathExists(changeLog)) {
      return {
        changelog: await fs.readFile(changeLog, 'utf8'),
      };
    } else {
      throw new NotFoundException();
    }
  }

  /**
   * Get the latest release notes from GitHub for a plugin
   * @param pluginName
   */
  public async getPluginRelease(pluginName: string) {
    if (!this.installedPlugins) await this.getInstalledPlugins();
    const plugin = this.installedPlugins.find(x => x.name === pluginName);
    if (!plugin) {
      throw new NotFoundException();
    }

    // plugin must have a homepage to workout Git Repo
    if (!plugin.links.homepage) {
      throw new NotFoundException();
    }

    // make sure the repo is GitHub
    if (!plugin.links.homepage.match(/https:\/\/github.com/)) {
      throw new NotFoundException();
    }

    try {
      const repo = plugin.links.homepage.split('https://github.com/')[1].split('#readme')[0];
      const release = await this.rp.get(`https://api.github.com/repos/${repo}/releases/latest`);
      return {
        name: release.name,
        changelog: release.body,
      };
    } catch (e) {
      throw new NotFoundException();
    }
  }

  /**
   * Returns a list of modules installed
   */
  private async getInstalledModules(): Promise<Array<{ name: string, path: string, installPath: string }>> {
    const allModules = [];
    // loop over each possible path to find installed plugins
    for (const requiredPath of this.paths) {
      const modules: any = await fs.readdir(requiredPath);
      for (const module of modules) {
        allModules.push({
          name: module,
          installPath: path.join(requiredPath, module),
          path: requiredPath,
        });
      }
    }
    return allModules;
  }

  /**
   * Helper function to work out where npm is
   */
  private getNpmPath() {
    if (os.platform() === 'win32') {
      // if running on windows find the full path to npm
      const windowsNpmPath = [
        path.join(process.env.APPDATA, 'npm/npm.cmd'),
        path.join(process.env.ProgramFiles, 'nodejs/npm.cmd'),
      ]
        .filter(fs.existsSync);

      if (windowsNpmPath.length) {
        return [windowsNpmPath[0], '--no-update-notifier'];
      } else {
        this.logger.error(`ERROR: Cannot find npm binary. You will not be able to manage plugins or update homebridge.`);
        this.logger.error(`ERROR: You might be able to fix this problem by running: npm install -g npm`);
      }

    }
    // Linux and macOS don't require the full path to npm
    return ['npm', '--no-update-notifier'];
  }

  /**
   * Get the paths used by Homebridge to load plugins
   * this is the same code used by homebridge to find plugins
   * https://github.com/nfarina/homebridge/blob/c73a2885d62531925ea439b9ad6d149a285f6daa/lib/plugin.js#L105-L134
   */
  private getBasePaths() {
    let paths = [];

    // add the paths used by require()
    // we need to use 'eval' on require to bypass webpack
    // tslint:disable-next-line: no-eval
    paths = paths.concat(eval('require').main.paths);

    if (this.configService.customPluginPath) {
      paths.unshift(this.configService.customPluginPath);
    }

    if (process.env.NODE_PATH) {
      paths = process.env.NODE_PATH.split(path.delimiter)
        .filter((p) => !!p) // trim out empty values
        .concat(paths);
    } else {
      // Default paths for each system
      if ((os.platform() === 'win32')) {
        paths.push(path.join(process.env.APPDATA, 'npm/node_modules'));
      } else {
        paths.push('/usr/local/lib/node_modules');
        paths.push('/usr/lib/node_modules');
        paths.push(child_process.execSync('/bin/echo -n "$(npm --no-update-notifier -g prefix)/lib/node_modules"').toString('utf8'));
      }
    }

    // filter out duplicates and non-existent paths
    return _.uniq(paths).filter((requiredPath) => {
      return fs.existsSync(requiredPath);
    });
  }

  /**
   * Convert the package.json into a HomebridgePlugin
   * @param pjson
   * @param installPath
   */
  private async parsePackageJson(pjson, installPath: string): Promise<HomebridgePlugin> {
    const plugin = {
      name: pjson.name,
      description: (pjson.description) ?
        pjson.description.replace(/(?:https?|ftp):\/\/[\n\S]+/g, '').trim() : pjson.name,
      certifiedPlugin: (pjson.name.indexOf('@homebridge/homebridge-') === 0),
      installedVersion: installPath ? (pjson.version || '0.0.1') : null,
      globalInstall: (installPath !== this.configService.customPluginPath),
      settingsSchema: await fs.pathExists(path.resolve(installPath, pjson.name, 'config.schema.json')),
      installPath,
    };

    return this.getPluginFromNpm(plugin);
  }

  /**
   * Accepts a HomebridgePlugin and adds data from npm
   * @param plugin
   */
  private async getPluginFromNpm(plugin: HomebridgePlugin): Promise<HomebridgePlugin> {
    try {
      const pkg = await this.rp.get(`https://registry.npmjs.org/${encodeURIComponent(plugin.name).replace('%40', '@')}`);
      plugin.publicPackage = true;
      plugin.latestVersion = pkg['dist-tags'].latest;
      plugin.updateAvailable = semver.lt(plugin.installedVersion, plugin.latestVersion);
      plugin.links = {
        npm: `https://www.npmjs.com/package/${plugin.name}`,
        homepage: pkg.homepage,
        bugs: (pkg.bugs) ? pkg.bugs.url : null,
      };
      plugin.author = (pkg.maintainers.length) ? pkg.maintainers[0].name : null;
    } catch (e) {
      if (e.statusCode !== 404) {
        this.logger.error(`[${plugin.name}] ${e.message}`);
      }
      plugin.publicPackage = false;
      plugin.latestVersion = null;
      plugin.updateAvailable = false;
      plugin.links = {};
    }
    return plugin;
  }

  /**
   * Executes an NPM command
   * @param command
   * @param cwd
   * @param client
   */
  private async runNpmCommand(command: Array<string>, cwd: string, client) {
    let timeoutTimer;
    command = command.filter(x => x.length);

    // sudo mode is requested in plugin config
    if (this.configService.ui.sudo) {
      command.unshift('sudo', '-E', '-n');
    } else {
      // do a pre-check to test for write access when not using sudo mode
      try {
        await fs.access(cwd, fs.constants.W_OK);
      } catch (e) {
        client.emit('stdout', color.yellow(`The user "${os.userInfo().username}" does not have write access to the target directory:\n\r\n\r`));
        client.emit('stdout', `${cwd}\n\r\n\r`);
        client.emit('stdout', color.yellow(`This may cause the operation to fail.\n\r`));
        client.emit('stdout', color.yellow(`See the docs for details on how to enable sudo mode:\n\r`));
        client.emit('stdout', color.yellow(`https://github.com/oznu/homebridge-config-ui-x#sudo-mode\n\r\n\r`));
      }
    }

    this.logger.log(`Running Command: ${command.join(' ')}`);

    if (!semver.satisfies(process.version, `>=${this.configService.minimumNodeVersion}`)) {
      client.emit('stdout', color.yellow(`Node.js v${this.configService.minimumNodeVersion} higher is required for ${this.configService.name}.\n\r`));
      client.emit('stdout', color.yellow(`You may experience issues while running on Node.js ${process.version}.\n\r\n\r`));
    }

    client.emit('stdout', color.cyan(`USER: ${os.userInfo().username}\n\r`));
    client.emit('stdout', color.cyan(`DIR: ${cwd}\n\r`));
    client.emit('stdout', color.cyan(`CMD: ${command.join(' ')}\n\r\n\r`));

    await new Promise((resolve, reject) => {
      const term = pty.spawn(command.shift(), command, {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        cwd,
        env: process.env,
      });

      // send stdout data from the process to all clients
      term.on('data', (data) => {
        client.emit('stdout', data);
      });

      // send an error message to the client if the command does not exit with code 0
      term.on('exit', (code) => {
        if (code === 0) {
          clearTimeout(timeoutTimer);
          client.emit('stdout', color.green(`\n\rCommand succeeded!.\n\r`));
          resolve();
        } else {
          clearTimeout(timeoutTimer);
          reject('Command failed. Please review log for details.');
        }
      });

      // if the command spends to long trying to execute kill it after 5 minutes
      timeoutTimer = setTimeout(() => {
        term.kill('SIGTERM');
      }, 300000);
    });
  }

  /**
   * When npm removes the last plugin in a custom node_modules location it may delete this location
   * which will cause errors. This function ensures the plugin directory is recreated if it was removed.
   */
  private async ensureCustomPluginDirExists() {
    if (!this.configService.customPluginPath) {
      return;
    }

    if (!await fs.pathExists(this.configService.customPluginPath)) {
      this.logger.warn(`Custom plugin directory was removed. Re-creating: ${this.configService.customPluginPath}`);
      try {
        await fs.ensureDir(this.configService.customPluginPath);
      } catch (e) {
        this.logger.error(`Failed to recreate custom plugin directory`);
        this.logger.error(e.message);
      }
    }
  }

}
