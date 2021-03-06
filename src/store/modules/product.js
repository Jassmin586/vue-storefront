import * as types from '../mutation-types'
import config from 'config'
import bodybuilder from 'bodybuilder'
import { quickSearchByQuery } from 'core/api/search'
import { entityKeyName } from '../../lib/entities'
import { optionLabel } from 'src/store/modules/attribute'
import { breadCrumbRoutes } from 'src/helpers'
import { calculateProductTax } from 'src/lib/taxcalc'
import _ from 'lodash'
import rootStore from '../'
import EventBus from 'src/plugins/event-bus'

function syncProductPrice (product, backProduct) { // TODO: we probably need to update the Net prices here as well
  product.sgn = backProduct.sgn // copy the signature for the modified price
  product.priceInclTax = backProduct.price_info.final_price
  product.originalPriceInclTax = backProduct.price_info.regular_price
  product.specialPriceInclTax = backProduct.price_info.special_price

  product.special_price = backProduct.price_info.extension_attributes.tax_adjustments.special_price
  product.price = backProduct.price_info.extension_attributes.tax_adjustments.final_price
  product.originalPrice = backProduct.price_info.extension_attributes.tax_adjustments.regular_price

  product.priceTax = product.priceInclTax - product.price
  product.specialPriceTax = product.specialPriceInclTax - product.special_price
  product.originalPriceTax = product.originalPriceInclTax - product.originalPrice

  if (product.priceInclTax >= product.originalPriceInclTax) {
    product.specialPriceInclTax = 0
    product.special_price = 0
  } else {
    product.special_price = 0 // the same price as original; it's not a promotion
  }
  EventBus.$emit('product-after-priceupdate', product)
  // console.log(product.sku, product, backProduct)
  return product
}
/**
 * Synchronize / override prices got from ElasticSearch with current one's from Magento2 or other platform backend
 * @param {Array} products
 */
function doPlatformPricesSync (products) {
  return new Promise((resolve, reject) => {
    if (config.products.alwaysSyncPlatformPricesOver) {
      if (config.products.clearPricesBeforePlatformSync) {
        for (let product of products) { // clear out the prices as we need to sync them with Magento
          product.priceInclTax = null
          product.originalPriceInclTax = null
          product.specialPriceInclTax = null

          product.special_price = null
          product.price = null
          product.originalPrice = null

          product.priceTax = null
          product.specialPriceTax = null
          product.originalPriceTax = null

          if (product.configurable_children) {
            for (let sc of product.configurable_children) {
              sc.priceInclTax = null
              sc.originalPriceInclTax = null
              sc.specialPriceInclTax = null

              sc.special_price = null
              sc.price = null
              sc.originalPrice = null

              sc.priceTax = null
              sc.specialPriceTax = null
              sc.originalPriceTax = null
            }
          }
        }
      }

      let skus = products.map((p) => { return p.sku })

      if (products.length === 1) { // single product - download child data
        const childSkus = _.flattenDeep(products.map((p) => { return (p.configurable_children) ? p.configurable_children.map((cc) => { return cc.sku }) : null }))
        skus = _.union(skus, childSkus)
      }
      console.log('Starting platform prices sync for', skus) // TODO: add option for syncro and non syncro return

      rootStore.dispatch('product/syncPlatformPricesOver', { skus: skus }, { root: true }).then((syncResult) => {
        if (syncResult) {
          syncResult = syncResult.items

          for (let product of products) {
            const backProduct = syncResult.find((itm) => { return itm.id === product.id })
            if (backProduct) {
              product.price_is_current = true // in case we're syncing up the prices we should mark if we do have current or not
              product.price_refreshed_at = new Date()
              product = syncProductPrice(product, backProduct)

              if (product.configurable_children) {
                for (let configurableChild of product.configurable_children) {
                  const backProductChild = syncResult.find((itm) => { return itm.id === configurableChild.id })
                  if (backProductChild) {
                    configurableChild = syncProductPrice(configurableChild, backProductChild)
                  }
                }
              }
              // TODO: shall we update local storage here for the main product?
            }
          }
        }
        resolve(products)
      })
      if (!config.products.waitForPlatformSync && !global.isSSR) {
        console.log('Returning products, the prices yet to come from backend!')
        for (let product of products) {
          product.price_is_current = false // in case we're syncing up the prices we should mark if we do have current or not
          product.price_refreshed_at = null
        }
        resolve(products)
      }
    } else {
      resolve(products)
    }
  })
}

/**
 * Calculate taxes for specific product collection
 */
function calculateTaxes (products, store) {
  return new Promise((resolve, reject) => {
    if (config.tax.calculateServerSide) {
      console.log('Taxes calculated server side, skipping')
      doPlatformPricesSync(products).then((products) => {
        resolve(products)
      })
    } else {
      store.dispatch('tax/list', { query: '' }, { root: true }).then((tcs) => { // TODO: move it to the server side for one requests OR cache in indexedDb
        for (let product of products) {
          product = calculateProductTax(product, tcs.items, global.__TAX_COUNTRY__, global.__TAX_REGION__)
        }
        doPlatformPricesSync(products).then((products) => {
          resolve(products)
        })
      }) // TODO: run Magento2 prices request here if configured so in the config
    }
  })
}

const state = {
  breadcrumbs: {routes: []},
  configured: null, // configured product with variant selected
  current: null, // shown product
  current_options: {color: [], size: []},
  current_configuration: {},
  parent: null,
  list: [],
  original: null, // default, not configured product
  related: {}
}

const getters = {
  productParent: (state) => state.parent,
  productCurrent: (state) => state.current,
  currentConfiguration: (state) => state.current_configuration,
  productOriginal: (state) => state.original,
  currentOptions: (state) => state.current_options,
  breadcrumbs: (state) => state.breadcrumbs
}

function configureProductAsync (context, { product, configuration, selectDefaultVariant = true }) {
  // use current product if product wasn't passed
  if (product === null) product = context.getters.productCurrent
  const hasConfigurableChildren = (product.configurable_children && product.configurable_children.length > 0)

  if (hasConfigurableChildren) {
    // handle custom_attributes for easier comparing in the future
    product.configurable_children.forEach((child) => {
      let customAttributesAsObject = {}
      child.custom_attributes.forEach((attr) => {
        customAttributesAsObject[attr.attribute_code] = attr.value
      })
      // add values from custom_attributes in a different form
      Object.assign(child, customAttributesAsObject)
    })
    // find selected variant
    let selectedVariant = product.configurable_children.find((configurableChild) => {
      if (configuration.sku) {
        return configurableChild.sku === configuration.sku // by sku or first one
      } else {
        return Object.keys(configuration).every((configProperty) => {
          return parseInt(configurableChild[configProperty]) === parseInt(configuration[configProperty].id)
        })
      }
    }) || product.configurable_children[0]

    if (typeof navigator !== 'undefined') {
      if (selectedVariant && !navigator.onLine) { // this is fix for not preloaded images for offline
        selectedVariant.image = product.image
      }
    }

    // use chosen variant
    if (selectDefaultVariant) {
      context.dispatch('setCurrent', selectedVariant)
    }
    return selectedVariant
  } else {
    return product
  }
}

// actions
const actions = {

  /**
   * Reset current configuration and selected variatnts
   */
  reset (context) {
    const productOriginal = context.getters.productOriginal
    context.commit(types.CATALOG_RESET_PRODUCT, productOriginal)
  },

  /**
   * Setup product breadcrumbs path
   */
  setupBreadcrumbs (context, { product }) {
    let subloaders = []
    let setbrcmb = (path) => {
      if (path.findIndex(itm => {
        return itm.slug === context.rootState.category.current.slug
      }) < 0) {
        path.push({
          slug: context.rootState.category.current.slug,
          name: context.rootState.category.current.name
        }) // current category at the end
      }
      context.dispatch('meta/set', { title: product.name }, { root: true })
      context.state.breadcrumbs.routes = breadCrumbRoutes(path) // TODO: change to store.commit call?
    }
    // TODO: Fix it when product is enterd from outside the category page
    let currentPath = context.rootState.category.current_path
    let currentCat = context.rootState.category.current

    if (currentPath.length > 0 && currentCat) {
      setbrcmb(currentPath)
    } else {
      if (product.category && product.category.length > 0) {
        subloaders.push(
          context.dispatch('category/list', {}, { root: true }).then((categories) => {
            for (let cat of product.category.reverse()) {
              let category = categories.items.find((itm) => { return itm['id'] === cat.category_id })
              if (category) {
                context.dispatch('category/single', { key: 'id', value: category.id }, { root: true }).then((category) => { // this sets up category path and current category
                  setbrcmb(context.rootState.category.current_path)
                }).catch(err => {
                  setbrcmb(context.rootState.category.current_path)
                  console.error(err)
                })
                break
              }
            }
          }, { root: true }).catch(err => {
            console.error(err)
          })
        )
      }
    }
    context.state.breadcrumbs.name = product.name

    return Promise.all(subloaders)
  },

  doPlatformPricesSync (context, { products }) {
    return doPlatformPricesSync(products)
  },

  /**
   * Download Magento2 / other platform prices to put them over ElasticSearch prices
   */
  syncPlatformPricesOver (context, { skus }) {
    return context.dispatch('sync/execute', { url: config.products.endpoint + '/render-list?skus=' + encodeURIComponent(skus.join(',') + '&currencyCode=' + config.i18n.currencyCode), // sync the cart
      payload: {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        mode: 'cors'
      },
      callback_event: 'prices-after-sync'
    }, { root: true }).then(task => {
      return task.result
    })
  },

  /**
   * Setup associated products
   */
  setupAssociated (context, { product }) {
    let subloaders = []
    if (product.type_id === 'grouped') {
      product.price = 0
      product.priceInclTax = 0
      console.log(product.name + ' SETUP ASSOCIATED')
      for (let pl of product.product_links) {
        if (pl.link_type === 'associated' && pl.linked_product_type === 'simple') { // prefetch links
          console.log('Prefetching grouped product link for ' + pl.sku + ' = ' + pl.linked_product_sku)
          subloaders.push(context.dispatch('single', {
            options: { sku: pl.linked_product_sku },
            setCurrentProduct: false,
            selectDefaultVariant: false
          }).catch(err => { console.log('err'); console.error(err) }).then((asocProd) => {
            pl.product = asocProd
            pl.product.qty = 1
            product.price += pl.product.price
            product.priceInclTax += pl.product.priceInclTax
            product.tax += pl.product.tax
          }))
        }
      }
    }
    return Promise.all(subloaders)
  },

  /**
   * This is fix for https://github.com/DivanteLtd/vue-storefront/issues/508
   * TODO: probably it would be better to have "parent_id" for simple products or to just ensure configurable variants are not visible in categories/search
   */
  checkConfigurableParent (context, {product}) {
    if (product.type_id === 'simple') {
      console.log('Checking configurable parent')
      let query = bodybuilder()
        .query('match', 'configurable_children.sku', context.state.current.sku)
        .build()

      return context.dispatch('list', {query, start: 0, size: 1, updateState: false}).then((resp) => {
        if (resp.items.length >= 1) {
          const parentProduct = resp.items[0]
          context.commit(types.CATALOG_SET_PRODUCT_PARENT, parentProduct)
        }
      }).catch(function (err) {
        console.error(err)
      })
    }
  },

  /**
   * Setup product current variants
   */
  setupVariants (context, { product }) {
    let subloaders = []
    if (product.type_id === 'configurable') {
      const configurableAttrIds = product.configurable_options.map(opt => opt.attribute_id)
      subloaders.push(context.dispatch('attribute/list', {
        filterValues: configurableAttrIds,
        filterField: 'attribute_id'
      }, { root: true }).then((attributes) => {
        for (let option of product.configurable_options) {
          for (let ov of option.values) {
            let lb = optionLabel(context.rootState.attribute, { attributeKey: option.attribute_id, searchBy: 'id', optionId: ov.value_index })
            if (_.trim(lb) !== '') {
              let optionKey = option.label.toLowerCase()
              if (!context.state.current_options[optionKey]) {
                context.state.current_options[optionKey] = []
              }
              context.state.current_options[optionKey].push({
                label: lb,
                id: ov.value_index
              })
            }
          }
        }
        let selectedVariant = context.state.current
        for (let option of product.configurable_options) {
          let attr = context.rootState.attribute.list_by_id[option.attribute_id]
          if (selectedVariant.custom_attributes) {
            let selectedOption = selectedVariant.custom_attributes.find((a) => {
              return (a.attribute_code === attr.attribute_code)
            })
            context.state.current_configuration[attr.attribute_code] = {
              attribute_code: attr.attribute_code,
              id: selectedOption.value,
              label: optionLabel(context.rootState.attribute, { attributeKey: selectedOption.attribute_code, searchBy: 'code', optionId: selectedOption.value })
            }
          }
        }
      }).catch(err => {
        console.error(err)
      }))
    }
    return Promise.all(subloaders)
  },
  /**
   * Search ElasticSearch catalog of products using simple text query
   * Use bodybuilder to build the query, aggregations etc: http://bodybuilder.js.org/
   * @param {Object} query elasticSearch request body
   * @param {Int} start start index
   * @param {Int} size page size
   * @return {Promise}
   */
  list (context, { query, start = 0, size = 50, entityType = 'product', sort = '', cacheByKey = 'sku', prefetchGroupProducts = true, updateState = true }) {
    return quickSearchByQuery({ query, start, size, entityType, sort }).then((resp) => {
      return calculateTaxes(resp.items, context).then((updatedProducts) => {
        // handle cache
        const cache = global.db.elasticCacheCollection
        for (let prod of resp.items) { // we store each product separately in cache to have offline access to products/single method
          if (!prod[cacheByKey]) {
            cacheByKey = 'id'
          }
          const cacheKey = entityKeyName(cacheByKey, prod[cacheByKey])
          cache.setItem(cacheKey, prod)
            .catch((err) => {
              console.error('Cannot store cache for ' + cacheKey + ', ' + err)
            })
          if (prod.type_id === 'grouped' && prefetchGroupProducts) {
            context.dispatch('setupAssociated', { product: prod })
          }
        }
        // commit update products list mutation
        if (updateState) {
          context.commit(types.CATALOG_UPD_PRODUCTS, resp)
        }
        return resp
      })
    }).catch(function (err) {
      console.error(err)
    })
  },

  /**
   * Search products by specific field
   * @param {Object} options
   */
  single (context, { options, setCurrentProduct = true, selectDefaultVariant = true, key = 'sku' }) {
    if (!options[key]) {
      throw Error('Please provide the search key ' + key + ' for product/single action!')
    }
    const cacheKey = entityKeyName(key, options[key])

    return new Promise((resolve, reject) => {
      const benchmarkTime = new Date()
      const cache = global.db.elasticCacheCollection
      cache.getItem(cacheKey, (err, res) => {
        // report errors
        if (err) {
          console.error({
            info: 'Get item from cache in ./store/modules/product.js',
            err
          })
        }
        const setupProduct = (prod) => {
          // set original product
          if (setCurrentProduct) {
            context.dispatch('setOriginal', prod)
          }
          // check is prod has configurable children
          const hasConfigurableChildren = prod && prod.configurable_children && prod.configurable_children.length
          // set current product - configurable or not
          if (prod.type_id === 'configurable' && hasConfigurableChildren) {
            // set first available configuration
            // todo: probably a good idea is to change this [0] to specific id
            configureProductAsync(context, { product: prod, configuration: { sku: options.childSku }, selectDefaultVariant: selectDefaultVariant })
          } else {
            if (setCurrentProduct) context.dispatch('setCurrent', prod)
          }
          return prod
        }
        if (res !== null) {
          console.debug('Product:single - result from localForage (for ' + cacheKey + '),  ms=' + (new Date().getTime() - benchmarkTime.getTime()))

          const cachedProduct = setupProduct(res)
          if (config.products.alwaysSyncPlatformPricesOver) {
            doPlatformPricesSync([cachedProduct]).then((products) => {
              resolve(products[0])
            })
            if (!config.products.waitForPlatformSync) {
              resolve(cachedProduct)
            }
          } else {
            resolve(cachedProduct)
          }
        } else {
          context.dispatch('list', { // product list syncs the platform price on it's own
            query: bodybuilder()
              .query('match', key, options[key])
              .build(),
            prefetchGroupProducts: false
          }).then((res) => {
            if (res && res.items && res.items.length) {
              resolve(setupProduct(res.items[0]))
            } else {
              reject(Error('Product query returned empty result'))
            }
          })
        }
      })// .catch((err) => { console.error('Cannot read cache for ' + cacheKey + ', ' + err) })
    })
  },
  /**
   * Configure product with given configuration and set it as current
   * @param {Object} context
   * @param {Object} product
   * @param {Array} configuration
   */
  configure (context, { product = null, configuration, selectDefaultVariant = true }) {
    return configureProductAsync(context, { product: product, configuration: configuration, selectDefaultVariant: selectDefaultVariant })
  },
  /**
   * Set current product with given variant's properties
   * @param {Object} context
   * @param {Object} productVariant
   */
  setCurrent (context, productVariant) {
    if (productVariant && typeof productVariant === 'object') {
      // get original product
      const productOriginal = context.getters.productOriginal
      // check if passed variant is the same as original
      const productUpdated = Object.assign({}, productOriginal, productVariant)
      context.commit(types.CATALOG_SET_PRODUCT_CURRENT, productUpdated)
    } else console.debug('Unable to update current product.')
  },
  /**
   * Set given product as original
   * @param {Object} context
   * @param {Object} originalProduct
   */
  setOriginal (context, originalProduct) {
    if (originalProduct && typeof originalProduct === 'object') context.commit(types.CATALOG_SET_PRODUCT_ORIGINAL, originalProduct)
    else console.debug('Unable to setup original product.')
  },
  /**
   * Set related products
   */
  related (context, { key = 'related-products', items }) {
    context.commit(types.CATALOG_UPD_RELATED, { key, items })
  }
}

// mutations
const mutations = {
  [types.CATALOG_UPD_RELATED] (state, { key, items }) {
    state.related[key] = items
  },
  [types.CATALOG_UPD_PRODUCTS] (state, products) {
    state.list = products // extract fields from ES _source
  },
  [types.CATALOG_SET_PRODUCT_CURRENT] (state, product) {
    state.current = product
  },
  [types.CATALOG_SET_PRODUCT_ORIGINAL] (state, product) {
    state.original = product
  },
  [types.CATALOG_SET_PRODUCT_PARENT] (state, product) {
    state.parent = product
  },
  [types.CATALOG_RESET_PRODUCT] (state, productOriginal) {
    state.current = productOriginal || {}
    state.current_configuration = {}
    state.parent = null
    state.current_options = {color: [], size: []}
  }
}

export default {
  namespaced: true,
  state,
  getters,
  actions,
  mutations
}
