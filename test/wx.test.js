import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wxKind, snowRange, forecastDays, hourlyChart } from '../public/wx.js';

test('weather icon kind from NWS short forecast', () => {
  assert.equal(wxKind('Sunny'), 'clear');
  assert.equal(wxKind('Mostly Sunny'), 'partly');
  assert.equal(wxKind('Mostly Cloudy'), 'cloudy');
  assert.equal(wxKind('Chance Snow Showers then Mostly Sunny'), 'snow');
  assert.equal(wxKind('Rain And Snow Likely'), 'mix');
  assert.equal(wxKind('Slight Chance Showers And Thunderstorms'), 'thunder');
  assert.equal(wxKind('Patchy Fog'), 'fog');
  assert.equal(wxKind('Breezy'), 'wind');
});

test('snow range from forecast text', () => {
  assert.deepEqual(snowRange('New snow accumulation of 2 to 4 inches possible.'), [2, 4]);
  assert.deepEqual(snowRange('New snow accumulation of around one inch possible.'), [1, 1]);
  assert.deepEqual(snowRange('New snow accumulation of less than half an inch possible.'), [0, 0.5]);
  assert.equal(snowRange('Sunny, with a high near 33.'), null);
});

test('periods pair into days, starting with tonight', () => {
  const days = forecastDays([
    { name: 'Tonight', temp: 12, isDaytime: false, short: 'Clear', detail: '' },
    { name: 'Saturday', temp: 27, isDaytime: true, short: 'Sunny', detail: 'New snow accumulation of 1 to 2 inches possible.' },
    { name: 'Saturday Night', temp: 8, isDaytime: false, short: 'Snow', detail: 'New snow accumulation of 2 to 3 inches possible.' },
  ]);
  assert.equal(days.length, 2);
  assert.equal(days[0].label, 'Tonight');
  assert.deepEqual([days[1].hi, days[1].lo, days[1].snow], [27, 8, [3, 5]]);
});

test('hourly chart needs at least two hours', () => {
  assert.equal(hourlyChart([]), '');
  assert.match(hourlyChart([{ t: 0, temp: 20, short: 'Snow', pop: 50 }, { t: 3600e3, temp: 22, short: 'Sunny' }]), /<svg class="wx-chart"/);
});
