import { GraphQLSchema } from 'graphql';
import { makeExecutableSchema, IResolvers } from 'graphql-tools';
import { mergeResolvers, mergeGraphQLSchemas } from '@graphql-modules/epoxy';
import logger from '@graphql-modules/logger';
import { GraphQLModule, IGraphQLContext } from './graphql-module';
import { CommunicationBridge } from './communication';

export interface NonModules {
  typeDefs?: any;
  resolvers?: any;
}

export interface InitParams {
  [key: string]: any;
}

export interface GraphQLAppOptions {
  modules: GraphQLModule[];
  nonModules?: NonModules;
  communicationBridge?: CommunicationBridge;
  initParams?: InitParams | (() => InitParams) | (() => Promise<InitParams>);
}

export class GraphQLApp {
  private readonly _modules: GraphQLModule[];
  private readonly _schema: GraphQLSchema;
  private readonly _resolvers: IResolvers;
  private _initModulesValue: { [key: string]: any; } = {};
  private _resolvedInitParams: { [key: string]: any; } = {};

  constructor(private options: GraphQLAppOptions) {
    const allTypes = options.modules.map<string>(m => m.typeDefs).filter(t => t);
    const nonModules = options.nonModules || {};

    this._modules = options.modules;
    this._resolvers = mergeResolvers(options.modules.map(m => m.resolvers || {}).concat(nonModules.resolvers || {}));
    this._schema = makeExecutableSchema({
      typeDefs: mergeGraphQLSchemas([
        ...allTypes,
        ...(Array.isArray(nonModules.typeDefs) ? nonModules.typeDefs : nonModules.typeDefs ? [nonModules.typeDefs] : []),
      ]),
      resolvers: this._resolvers,
    });
  }

  async init(): Promise<void> {
    let params: InitParams = null;
    const builtResult = {};

    if (this.options && this.options.initParams) {
      if (typeof this.options.initParams === 'object') {
        params = this.options.initParams;
      } else if (typeof this.options.initParams === 'function') {
        params = await this.options.initParams();
      }
    }

    this._resolvedInitParams = params;

    const relevantModules: GraphQLModule[] = this._modules.filter(f => f.onInit);
    let module;

    try {
      for (module of relevantModules) {
        const appendToContext: any = await module.onInit(params);

        if (appendToContext && typeof appendToContext === 'object') {
          Object.assign(builtResult, { [module.name]: appendToContext });
        }
      }
    } catch (e) {
      logger.error(`Unable to initialized module! Module "${module.name}" failed: `, e);

      throw e;
    }

    this._initModulesValue = builtResult;
  }

  get schema(): GraphQLSchema {
    return this._schema;
  }

  get resolvers(): IResolvers {
    return this._resolvers;
  }

  private buildImplementationsObject() {
    const relevantImplModules: GraphQLModule[] = this._modules.filter(f => f.implementation);
    const result = {};

    for (const module of relevantImplModules) {
      result[module.name] = module.implementation;
    }

    return result;
  }

  async buildContext(networkRequest?: any): Promise<IGraphQLContext> {
    const relevantContextModules: GraphQLModule[] = this._modules.filter(f => f.contextBuilder);
    const builtResult = { ...this._initModulesValue, initParams: this._resolvedInitParams || {} };
    const result = this.buildImplementationsObject();

    let module;
    try {
      for (module of relevantContextModules) {
        const appendToContext: any = await module.contextBuilder(networkRequest);

        if (appendToContext && typeof appendToContext === 'object') {
          Object.assign(builtResult, appendToContext);
        }
      }
    } catch (e) {
      logger.error(`Unable to build context! Module "${module.name}" failed: `, e);

      throw e;
    }

    const builtKeys = Object.keys(builtResult);

    for (const key of builtKeys) {
      if (result.hasOwnProperty(key)) {
        logger.warn(`One of you context builders returned a key named ${key}, and it's conflicting with a root module name! Ignoring...`);
      } else {
        result[key] = builtResult[key];
      }
    }

    return result;
  }
}