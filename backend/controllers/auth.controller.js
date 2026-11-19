import * as authService from '../services/auth.service.js';

export async function register(req, res) {
  const { user, token } = await authService.registerUser(req.body);
  res.status(201).json({ success: true, message: 'Account created successfully', data: { user, token } });
}

export async function login(req, res) {
  const { user, token } = await authService.loginUser(req.body);
  res.json({ success: true, message: 'Logged in successfully', data: { user, token } });
}

export async function me(req, res) {
  const user = await authService.getUserProfile(req.user.id);
  res.json({ success: true, data: { user } });
}
