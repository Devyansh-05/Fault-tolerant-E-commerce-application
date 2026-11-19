import * as cartService from '../services/cart.service.js';

const send = (res, cart, message) => res.json({ success: true, ...(message && { message }), data: { cart } });

export async function getCart(req, res) {
  send(res, await cartService.getCart(req.user.id));
}

export async function addItem(req, res) {
  send(res, await cartService.addItem(req.user.id, req.body), 'Added to cart');
}

export async function updateItem(req, res) {
  send(res, await cartService.updateItem(req.user.id, req.body), 'Cart updated');
}

export async function removeItem(req, res) {
  send(res, await cartService.removeItem(req.user.id, req.validated.params.productId), 'Item removed');
}

export async function clearCart(req, res) {
  send(res, await cartService.clearCart(req.user.id), 'Cart cleared');
}
