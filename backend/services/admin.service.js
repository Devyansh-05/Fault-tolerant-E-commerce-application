import { Order, Product, User, ORDER_STATUS } from '../models/index.js';

/**
 * Basic admin overview. Synthetic data from the Stage 3 event generator (test orders and the
 * synthetic test customer) is excluded so business numbers stay real. Reliability statistics
 * live in eventMonitoring.service.js.
 */
export async function getOverviewStats() {
  const realOrders = { isTest: { $ne: true } };
  const [totalUsers, totalProducts, totalOrders, revenue, recentOrders, testOrders] = await Promise.all([
    User.countDocuments({ isSynthetic: { $ne: true } }),
    Product.countDocuments({ isActive: true }),
    Order.countDocuments(realOrders),
    Order.aggregate([
      { $match: { ...realOrders, orderStatus: ORDER_STATUS.CONFIRMED } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } },
    ]),
    Order.find(realOrders).sort({ createdAt: -1 }).limit(10).populate('userId', 'name email'),
    Order.countDocuments({ isTest: true }),
  ]);

  return {
    totalUsers,
    totalProducts,
    totalOrders,
    syntheticTestOrders: testOrders,
    confirmedRevenue: Math.round((revenue[0]?.total ?? 0) * 100) / 100,
    recentOrders: recentOrders.map((order) => {
      const json = order.toJSON();
      const customer = order.userId;
      return {
        ...json,
        userId: customer?._id ? String(customer._id) : String(order.userId),
        customer: customer?.name ? { name: customer.name, email: customer.email } : null,
      };
    }),
  };
}
