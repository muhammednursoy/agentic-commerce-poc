export interface Item {
  id: string;
  quantity: number;
}

export interface Address {
  name?: string;
  line_one: string;
  line_two?: string;
  city: string;
  state?: string;
  country: string;
  postal_code: string;
}

export interface Buyer {
  email?: string;
  first_name?: string;
  last_name?: string;
  phone_number?: string;
}

export interface Product {
  id: string;
  title: string;
  description: string;
  price: number;
  currency: string;
  stock: number;
}

export function formatAmount(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
}
