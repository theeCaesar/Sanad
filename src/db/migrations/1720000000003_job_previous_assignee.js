exports.up = (pgm) => {
  pgm.addColumn('jobs', {
    previous_assigned_to: { type: 'uuid', references: 'users' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('jobs', 'previous_assigned_to');
};
