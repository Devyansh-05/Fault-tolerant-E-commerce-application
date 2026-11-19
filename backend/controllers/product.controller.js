import * as productService from '../services/product.service.js';

export async function list(req, res) {
  const result = await productService.listProducts(req.validated.query);
  res.json({ success: true, data: result });
}

export async function categories(req, res) {
  res.json({ success: true, data: { categories: await productService.listCategories() } });
}

export async function getById(req, res) {
  res.json({ success: true, data: { product: await productService.getProductById(req.validated.params.id) } });
}

export async function create(req, res) {
  const product = await productService.createProduct(req.body);
  res.status(201).json({ success: true, message: 'Product created', data: { product } });
}

export async function update(req, res) {
  const product = await productService.updateProduct(req.validated.params.id, req.body);
  res.json({ success: true, message: 'Product updated', data: { product } });
}

export async function remove(req, res) {
  await productService.deleteProduct(req.validated.params.id);
  res.json({ success: true, message: 'Product deleted' });
}
