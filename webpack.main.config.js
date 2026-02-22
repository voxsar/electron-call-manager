const path = require('path');

module.exports = {
  mode: 'development',
  entry: './src/main/main.ts',
  target: 'electron-main',
  output: {
    path: path.resolve(__dirname, 'dist/main'),
    filename: 'main.js',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  externals: {
    serialport: 'commonjs serialport',
    '@serialport/parser-readline': 'commonjs @serialport/parser-readline',
    'electron-store': 'commonjs electron-store',
  },
  node: {
    __dirname: false,
    __filename: false,
  },
};
