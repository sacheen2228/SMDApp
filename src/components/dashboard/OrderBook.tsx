// Order Book Component
// Shows pending, executed, and rejected orders

'use client';

import React, { useEffect, useState } from 'react';
import { useTradingStore } from '@/stores/useTradingStore';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, XCircle, Clock, CheckCircle, AlertCircle } from 'lucide-react';

export function OrderBook() {
  const { orders, setOrders } = useTradingStore();
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'all' | 'pending' | 'executed'>('all');
  
  const fetchOrders = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/orders');
      const data = await res.json();
      if (data.success) {
        setOrders(data.data || []);
      }
    } catch (error) {
      console.error('Failed to fetch orders:', error);
    } finally {
      setLoading(false);
    }
  };
  
  useEffect(() => {
    fetchOrders();
    const interval = setInterval(fetchOrders, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, []);
  
  const filteredOrders = orders.filter(order => {
    if (tab === 'pending') return order.status === 'pending' || order.status === 'open' || order.status === 'trigger pending';
    if (tab === 'executed') return order.status === 'executed' || order.status === 'completed';
    return true;
  });
  
  const handleCancel = async (orderId: string) => {
    try {
      const res = await fetch(`/api/orders?orderId=${orderId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        fetchOrders();
      }
    } catch (error) {
      console.error('Failed to cancel order:', error);
    }
  };
  
  const getStatusIcon = (status: string) => {
    switch (status.toLowerCase()) {
      case 'pending':
      case 'open':
      case 'trigger pending':
        return <Clock className="h-3 w-3 text-amber-500" />;
      case 'executed':
      case 'completed':
        return <CheckCircle className="h-3 w-3 text-emerald-500" />;
      case 'rejected':
      case 'cancelled':
        return <XCircle className="h-3 w-3 text-red-500" />;
      default:
        return <AlertCircle className="h-3 w-3 text-muted-foreground" />;
    }
  };
  
  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'pending':
      case 'open':
      case 'trigger pending':
        return 'bg-amber-500/10 text-amber-500';
      case 'executed':
      case 'completed':
        return 'bg-emerald-500/10 text-emerald-500';
      case 'rejected':
      case 'cancelled':
        return 'bg-red-500/10 text-red-500';
      default:
        return 'bg-muted text-muted-foreground';
    }
  };
  
  return (
    <div className="border rounded-lg bg-card">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b">
        <h3 className="text-sm font-bold">Order Book</h3>
        <Button variant="ghost" size="sm" onClick={fetchOrders} disabled={loading}>
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      
      {/* Tabs */}
      <div className="flex border-b">
        {(['all', 'pending', 'executed'] as const).map(t => (
          <button
            key={t}
            className={`flex-1 py-2 text-xs font-medium capitalize ${
              tab === t ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground'
            }`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      
      {/* Orders List */}
      <div className="max-h-[300px] overflow-auto">
        {filteredOrders.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            No orders found
          </div>
        ) : (
          filteredOrders.map(order => (
            <div key={order.orderId} className="flex items-center justify-between p-3 border-b last:border-0 hover:bg-muted/30">
              <div className="flex items-center gap-2">
                {getStatusIcon(order.status)}
                <div>
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-bold">{order.stockCode}</span>
                    <Badge className={`text-[9px] px-1 ${order.action === 'buy' ? 'bg-emerald-600' : 'bg-red-600'}`}>
                      {order.action.toUpperCase()}
                    </Badge>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    ₹{order.price} × {order.quantity}
                  </p>
                </div>
              </div>
              
              <div className="flex items-center gap-2">
                <Badge className={`text-[9px] ${getStatusColor(order.status)}`}>
                  {order.status}
                </Badge>
                {(order.status === 'pending' || order.status === 'open') && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => handleCancel(order.orderId)}
                  >
                    <XCircle className="h-3 w-3 text-red-500" />
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
