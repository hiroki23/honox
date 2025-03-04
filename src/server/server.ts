/* eslint-disable @typescript-eslint/no-explicit-any */
import { Hono } from 'hono'
import type { Env, NotFoundHandler, ErrorHandler, MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { H } from 'hono/types'
import { IMPORTING_ISLANDS_ID } from '../constants.js'
import {
  filePathToPath,
  groupByDirectory,
  listByDirectory,
  sortDirectoriesByDepth,
} from '../utils/file.js'

const NOTFOUND_FILENAME = '_404.tsx'
const ERROR_FILENAME = '_error.tsx'
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'] as const

type AppFile = { default: Hono }

type InnerMeta = {
  [key in typeof IMPORTING_ISLANDS_ID]?: boolean
}

type RouteFile = {
  default?: Function
} & { [M in (typeof METHODS)[number]]?: H[] } & InnerMeta

type RendererFile = { default: MiddlewareHandler }
type NotFoundFile = { default: NotFoundHandler }
type ErrorFile = { default: ErrorHandler }
type MiddlewareFile = { default: MiddlewareHandler[] }

type InitFunction<E extends Env = Env> = (app: Hono<E>) => void

type BaseServerOptions<E extends Env = Env> = {
  ROUTES: Record<string, RouteFile | AppFile>
  RENDERER: Record<string, RendererFile>
  NOT_FOUND: Record<string, NotFoundFile>
  ERROR: Record<string, ErrorFile>
  MIDDLEWARE: Record<string, MiddlewareFile>
  root: string
  app?: Hono<E>
  init?: InitFunction<E>
}

export type ServerOptions<E extends Env = Env> = Partial<BaseServerOptions<E>>

export const createApp = <E extends Env>(options: BaseServerOptions<E>): Hono<E> => {
  const root = options.root
  const rootRegExp = new RegExp(`^${root}`)
  const app = options.app ?? new Hono()

  if (options.init) {
    options.init(app)
  }

  // Not Found
  const NOT_FOUND_FILE = options.NOT_FOUND
  const notFoundMap = groupByDirectory(NOT_FOUND_FILE)

  // Error
  const ERROR_FILE = options.ERROR
  const errorMap = groupByDirectory(ERROR_FILE)

  // Renderer
  const RENDERER_FILE = options.RENDERER
  const rendererList = listByDirectory(RENDERER_FILE)

  // Middleware
  const MIDDLEWARE_FILE = options.MIDDLEWARE
  const middlewareList = listByDirectory(MIDDLEWARE_FILE)

  // Routes
  const ROUTES_FILE = options.ROUTES
  const routesMap = sortDirectoriesByDepth(groupByDirectory<RouteFile | AppFile>(ROUTES_FILE))

  const getPaths = (currentDirectory: string, fileList: Record<string, string[]>) => {
    let paths = fileList[currentDirectory] ?? []

    const getChildPaths = (childDirectories: string[]) => {
      paths = fileList[childDirectories.join('/')]
      if (!paths) {
        childDirectories.pop()
        if (childDirectories.length) {
          getChildPaths(childDirectories)
        }
      }
      return paths ?? []
    }

    const renderDirPaths = currentDirectory.split('/')
    paths = getChildPaths(renderDirPaths)
    paths.sort((a, b) => a.split('/').length - b.split('/').length)
    return paths
  }

  for (const map of routesMap) {
    for (const [dir, content] of Object.entries(map)) {
      const subApp = new Hono()

      // Renderer
      const rendererPaths = getPaths(dir, rendererList)
      rendererPaths.map((path) => {
        const renderer = RENDERER_FILE[path]
        const rendererDefault = renderer.default
        if (rendererDefault) {
          subApp.all('*', rendererDefault)
        }
      })

      // Middleware
      const middlewarePaths = getPaths(dir, middlewareList)
      middlewarePaths.map((path) => {
        const middleware = MIDDLEWARE_FILE[path]
        const middlewareDefault = middleware.default
        if (middlewareDefault) {
          subApp.use(...middlewareDefault)
        }
      })

      // Root path
      let rootPath = dir.replace(rootRegExp, '')
      rootPath = filePathToPath(rootPath)

      for (const [filename, route] of Object.entries(content)) {
        // @ts-expect-error route[IMPORTING_ISLANDS_ID] is not typed
        const importingIslands = route[IMPORTING_ISLANDS_ID] as boolean
        const setInnerMeta = createMiddleware(async function innerMeta(c, next) {
          c.set(IMPORTING_ISLANDS_ID as any, importingIslands)
          await next()
        })

        const routeDefault = route.default
        const path = filePathToPath(filename)

        // Instance of Hono
        if (routeDefault && 'fetch' in routeDefault) {
          subApp.route(path, routeDefault)
        }

        // export const POST = factory.createHandlers(...)
        for (const m of METHODS) {
          const handlers = (route as Record<string, H[]>)[m]
          if (handlers) {
            subApp.on(m, path, setInnerMeta)
            subApp.on(m, path, ...handlers)
          }
        }

        // export default factory.createHandlers(...)
        if (routeDefault && Array.isArray(routeDefault)) {
          subApp.get(path, setInnerMeta)
          subApp.get(path, ...(routeDefault as H[]))
        }

        // export default function Helle() {}
        if (typeof routeDefault === 'function') {
          subApp.get(path, setInnerMeta)
          subApp.get(path, (c) => {
            return c.render(routeDefault(c), route as any)
          })
        }
      }
      // Not Found
      applyNotFound(subApp, dir, notFoundMap)
      // Error
      applyError(subApp, dir, errorMap)
      app.route(rootPath, subApp)
    }
  }

  return app
}

function applyNotFound(app: Hono, dir: string, map: Record<string, Record<string, NotFoundFile>>) {
  for (const [mapDir, content] of Object.entries(map)) {
    if (dir === mapDir) {
      const notFound = content[NOTFOUND_FILENAME]
      if (notFound) {
        const notFoundHandler = notFound.default
        app.get('*', (c) => {
          c.status(404)
          return notFoundHandler(c)
        })
      }
    }
  }
}

function applyError(app: Hono, dir: string, map: Record<string, Record<string, ErrorFile>>) {
  for (const [mapDir, content] of Object.entries(map)) {
    if (dir === mapDir) {
      const error = content[ERROR_FILENAME]
      if (error) {
        const errorHandler = error.default
        app.onError((error, c) => {
          c.status(500)
          return errorHandler(error, c)
        })
      }
    }
  }
}
