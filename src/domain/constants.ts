import type { Draft } from './types';

export const emptyDraft: Draft = {
  name: '',
  category: 'Винты и крепеж',
  quantity: 0,
  unit: 'шт',
  location: '',
  locations: [],
  barcode: '',
  project: '',
  projects: [],
  tags: [],
  containerId: '',
  photo: '',
  minQuantity: 0,
  reorderPoint: 0,
  targetQuantity: 0,
  note: ''
};

export const categories = [
  'Винты и крепеж',
  'Гайки и шайбы',
  'Батарейки',
  'Электрика',
  'Клей и химия',
  'Ленты и изоляция',
  'Инструментальные мелочи',
  'Прочее'
];

export const units = ['шт', 'упак', 'м', 'мл', 'г', 'компл'];
export const themeKey = 'garage_inventory_theme';
