function readPackage(pkg, context) {
  // Override vulnerable dependencies
  const overrides = {
    'proxy-addr': '2.0.8',
    'nanoid': '3.3.19',
    'browserslist': '4.29.3',
    'fast-uri': '4.2.2',
    'source-map-js': '1.2.2',
    '@modelcontextprotocol/sdk': '1.31.0',
  };

  // Apply overrides to dependencies
  if (pkg.dependencies) {
    for (const [name, version] of Object.entries(overrides)) {
      if (pkg.dependencies[name]) {
        context.log(`Overriding ${name} from ${pkg.dependencies[name]} to ${version}`);
        pkg.dependencies[name] = version;
      }
    }
  }

  return pkg;
}

module.exports = {
  hooks: {
    readPackage,
  },
};
