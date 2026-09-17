import { Router } from 'express';
import auth from './auth.js';
import catalog from './catalog.js';
import addresses from './addresses.js';
import team from './team.js';
import orders from './orders.js';
import account from './account.js';
import quotes from './quotes.js';
import uploads from './uploads.js';
import notifications from './notifications.js';
import leads from './leads.js';
import admin from './admin.js';

const r = Router();
r.use('/auth', auth);
r.use('/catalog', catalog);
r.use('/addresses', addresses);
r.use('/team', team);
r.use('/orders', orders);
r.use('/', account); // /invoices, /dashboard, /devices
r.use('/quotes', quotes);
r.use('/uploads', uploads);
r.use('/notifications', notifications);
r.use('/leads', leads);
r.use('/admin', admin);
export default r;
