// Order Panel Component
// Buy/Sell orders from option chain

'use client';

import React, { useState } from 'react';
import { useTradingStore } from '@/stores/useTradingStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { X, Zap } from 'lucide-react';

export function OrderPanel() {
  const { 
    showOrderPanel, 
    setShowOrderPanel, 
    selectedStrike, 
    selectedOption, 
    selectedSymbol, 
    selectedExpiry,
    spotPrice 
  } = useTradingStore();
  
  const [action, setAction] = useState<'buy' | 'sell'>('buy');
  const [quantity, setQuantity] = useState('25');
  const [price, setPrice] = useState('');
  const [orderType, setOrderType] = useState<'limit' | 'market'>('limit');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  
  if (!showOrderPanel || !selectedStrike || !selectedOption) return null;
  
  const handlePlaceOrder = async () => {
    setLoading(true);
    setResult(null);
    
    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stockCode: selectedSymbol,
          exchangeCode: 'NFO',
          product: 'options',
          action,
          orderType: orderType === 'market' ? 'limit' : 'limit',
          quantity,
          price: orderType === 'market' ? '0' : price,
          validity: orderType === 'market' ? 'ioc' : 'day',
          expiryDate: selectedExpiry,
          right: selectedOption,
          strikePrice: String(selectedStrike),
          userRemark: `SDM ${action} ${selectedStrike} ${selectedOption}`,
        }),
      });
      
      const data = await response.json();
      
      if (data.success) {
        setResult({ success: true, message: `Order placed: ${data.data.orderId}` });
        setTimeout(() => {
          setShowOrderPanel(false);
          setResult(null);
        }, 2000);
      } else {
        setResult({ success: false, message: data.error || 'Failed to place order' });
      }
    } catch (error: any) {
      setResult({ success: false, message: error.message || 'Network error' });
    } finally {
      setLoading(false);
    }
  };
  
  const optionLabel = selectedOption === 'call' ? 'CE' : 'PE';
  const isBuy = action === 'buy';
  
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card border rounded-lg w-[400px] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-2">
            <Zap className={`h-4 w-4 ${isBuy ? 'text-emerald-500' : 'text-red-500'}`} />
            <h3 className="font-bold">Place Order</h3>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setShowOrderPanel(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        
        {/* Order Details */}
        <div className="p-4 space-y-4">
          {/* Symbol + Strike + Option */}
          <div className="bg-muted/50 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-bold">{selectedSymbol}</p>
                <p className="text-xs text-muted-foreground">{selectedExpiry}</p>
              </div>
              <div className="text-right">
                <Badge className={isBuy ? 'bg-emerald-600' : 'bg-red-600'}>
                  {action.toUpperCase()}
                </Badge>
                <p className="text-sm font-bold mt-1">₹{selectedStrike} {optionLabel}</p>
              </div>
            </div>
            {spotPrice > 0 && (
              <p className="text-[10px] text-muted-foreground mt-1">Spot: ₹{spotPrice}</p>
            )}
          </div>
          
          {/* Buy/Sell Toggle */}
          <div className="flex gap-2">
            <Button
              variant={action === 'buy' ? 'default' : 'outline'}
              className={`flex-1 ${action === 'buy' ? 'bg-emerald-600 hover:bg-emerald-700' : ''}`}
              onClick={() => setAction('buy')}
            >
              BUY
            </Button>
            <Button
              variant={action === 'sell' ? 'default' : 'outline'}
              className={`flex-1 ${action === 'sell' ? 'bg-red-600 hover:bg-red-700' : ''}`}
              onClick={() => setAction('sell')}
            >
              SELL
            </Button>
          </div>
          
          {/* Order Type */}
          <div className="flex gap-2">
            <Button
              variant={orderType === 'limit' ? 'default' : 'outline'}
              size="sm"
              className="flex-1"
              onClick={() => setOrderType('limit')}
            >
              Limit
            </Button>
            <Button
              variant={orderType === 'market' ? 'default' : 'outline'}
              size="sm"
              className="flex-1"
              onClick={() => setOrderType('market')}
            >
              Market
            </Button>
          </div>
          
          {/* Quantity */}
          <div>
            <Label className="text-xs">Quantity (Lot Size: 25)</Label>
            <Input
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              min="25"
              step="25"
              className="mt-1"
            />
          </div>
          
          {/* Price (Limit only) */}
          {orderType === 'limit' && (
            <div>
              <Label className="text-xs">Price (₹)</Label>
              <Input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="Enter limit price"
                className="mt-1"
              />
            </div>
          )}
          
          {/* Result */}
          {result && (
            <div className={`p-2 rounded text-sm ${result.success ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'}`}>
              {result.message}
            </div>
          )}
          
          {/* Place Order Button */}
          <Button
            className={`w-full ${isBuy ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'}`}
            onClick={handlePlaceOrder}
            disabled={loading || (orderType === 'limit' && !price)}
          >
            {loading ? 'Placing Order...' : `${action.toUpperCase()} ${selectedStrike} ${optionLabel}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
